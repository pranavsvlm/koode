import {
  RING_TIMEOUT_MS,
  StartCallRequest,
  type Call,
  type CallJoin,
  type CallState,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { newId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { mediaToken } from '../lib/livekit';
import { parseJson } from '../lib/validate';
import { publishCall } from '../calls/events';
import { COLUMNS, displayName, toCall, transition, type CallRow } from '../calls/rows';

/** An "active" call older than this is assumed abandoned (app crashed etc.). */
const STALE_ACTIVE_MS = 4 * 60 * 60_000;

/**
 * The CallTimer alarm marks unanswered calls missed (and sends the missed-call
 * push) at the timeout. This lazy sweep is a backstop, with a grace period so
 * the alarm normally wins.
 */
const EXPIRY_GRACE_MS = 15_000;
async function expireRinging(db: D1Database, now = Date.now()) {
  await db
    .prepare(
      "UPDATE calls SET state = 'missed', ended_at = created_at + ? WHERE state = 'ringing' AND created_at < ?",
    )
    .bind(RING_TIMEOUT_MS, now - RING_TIMEOUT_MS - EXPIRY_GRACE_MS)
    .run();
}

async function loadCall(db: D1Database, id: string, userId: string): Promise<CallRow> {
  await expireRinging(db);
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM calls WHERE id = ?`)
    .bind(id)
    .first<CallRow>();
  // Non-participants get the same 404 as a missing call.
  if (!row || (row.caller_id !== userId && row.callee_id !== userId))
    throw new ApiError('not_found', 'Call not found');
  return row;
}

export const calls = new Hono<AppEnv>()
  .use(requireAuth)

  .get('/', async (c) => {
    const { userId } = c.get('auth');
    await expireRinging(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT ${COLUMNS} FROM calls WHERE caller_id = ?1 OR callee_id = ?1 ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(userId)
      .all<CallRow>();
    return c.json<{ calls: Call[] }>({ calls: results.map(toCall) });
  })

  .post('/', async (c) => {
    const { userId, kind } = await parseJson(c, StartCallRequest);
    const me = c.get('auth').userId;
    const db = c.env.DB;
    if (userId === me) throw new ApiError('bad_request', 'You can’t call yourself');
    const callee = await db
      .prepare("SELECT id FROM users WHERE id = ? AND status = 'active'")
      .bind(userId)
      .first();
    if (!callee) throw new ApiError('not_found', 'User not found');

    await expireRinging(db);
    const now = Date.now();
    const busy = await db
      .prepare(
        `SELECT caller_id, callee_id FROM calls WHERE state IN ('ringing', 'active') AND created_at > ?
         AND (caller_id IN (?, ?) OR callee_id IN (?, ?)) LIMIT 1`,
      )
      .bind(now - STALE_ACTIVE_MS, me, userId, me, userId)
      .first();
    if (busy) throw new ApiError('conflict', 'Busy: one of you is already in a call');

    const row: CallRow = {
      id: newId('cal'),
      kind,
      caller_id: me,
      callee_id: userId,
      state: 'ringing',
      created_at: now,
      answered_at: null,
      ended_at: null,
    };
    await db
      .prepare(`INSERT INTO calls (${COLUMNS}) VALUES (?, ?, ?, ?, 'ringing', ?, NULL, NULL)`)
      .bind(row.id, kind, me, userId, now)
      .run();
    const call = toCall(row);
    const timer = c.env.CALL_TIMER.get(c.env.CALL_TIMER.idFromName(row.id));
    await timer.arm(row.id, now + RING_TIMEOUT_MS);
    // Rings the callee: realtime for open apps, VoIP/FCM push for the rest.
    c.executionCtx.waitUntil(publishCall(c.env, call, { wasRinging: false }));
    const media = await mediaToken(c.env, {
      room: row.id,
      identity: me,
      name: await displayName(db, me),
    });
    return c.json<CallJoin>({ call, media }, 201);
  })

  .get('/:id', async (c) =>
    c.json<Call>(toCall(await loadCall(c.env.DB, c.req.param('id'), c.get('auth').userId))),
  )

  .post('/:id/accept', async (c) => {
    const me = c.get('auth').userId;
    const db = c.env.DB;
    const current = await loadCall(db, c.req.param('id'), me);
    if (current.callee_id !== me)
      throw new ApiError('forbidden', 'Only the person being called can answer');
    const row = await transition(db, current.id, ['ringing'], 'active', 'answered');
    if (!row) throw new ApiError('conflict', 'This call is no longer ringing');
    const call = toCall(row);
    // Stops the ringing on the callee's other devices.
    c.executionCtx.waitUntil(
      publishCall(c.env, call, { wasRinging: true, exceptDeviceId: c.get('auth').deviceId }),
    );
    const media = await mediaToken(c.env, {
      room: row.id,
      identity: me,
      name: await displayName(db, me),
    });
    return c.json<CallJoin>({ call, media });
  })

  /** Fresh join credentials for an active call (e.g. the app restarted mid-call). */
  .post('/:id/rejoin', async (c) => {
    const me = c.get('auth').userId;
    const row = await loadCall(c.env.DB, c.req.param('id'), me);
    if (row.state !== 'active') throw new ApiError('conflict', 'This call has ended');
    const media = await mediaToken(c.env, {
      room: row.id,
      identity: me,
      name: await displayName(c.env.DB, me),
    });
    return c.json<CallJoin>({ call: toCall(row), media });
  })

  .post('/:id/decline', async (c) => {
    const me = c.get('auth').userId;
    const current = await loadCall(c.env.DB, c.req.param('id'), me);
    if (current.callee_id !== me)
      throw new ApiError('forbidden', 'Only the person being called can decline');
    const changed = await transition(c.env.DB, current.id, ['ringing'], 'declined', 'ended');
    const call = toCall(changed ?? current);
    c.executionCtx.waitUntil(
      publishCall(c.env, call, { wasRinging: !!changed, exceptDeviceId: c.get('auth').deviceId }),
    );
    return c.json<Call>(call);
  })

  /**
   * Hang up. Caller while ringing → cancelled (or missed once the ring timed
   * out); callee while ringing → declined; either party when active → ended.
   * Already-finished calls are returned unchanged (idempotent).
   */
  .post('/:id/end', async (c) => {
    const me = c.get('auth').userId;
    const db = c.env.DB;
    const current = await loadCall(db, c.req.param('id'), me);
    let row: CallRow | null = current;
    if (current.state === 'ringing') {
      const to: CallState =
        current.callee_id === me
          ? 'declined'
          : Date.now() - current.created_at >= RING_TIMEOUT_MS
            ? 'missed'
            : 'cancelled';
      row = await transition(db, current.id, ['ringing'], to, 'ended');
    } else if (current.state === 'active') {
      row = await transition(db, current.id, ['active'], 'ended', 'ended');
    }
    const wasRinging = current.state === 'ringing' && row !== null;
    row ??= await loadCall(db, current.id, me); // lost a race: return whatever won
    const call = toCall(row);
    c.executionCtx.waitUntil(
      publishCall(c.env, call, { wasRinging, exceptDeviceId: c.get('auth').deviceId }),
    );
    return c.json<Call>(call);
  });
