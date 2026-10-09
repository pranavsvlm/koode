import type { OkResponse } from '@koode/shared';
import {
  CreateInviteRequest,
  InviteCode,
  type CreatedInvite,
  type Invite,
  type InvitePreview,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { auditStatement } from '../lib/audit';
import { newId, randomCrockford, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { rateLimit, RULES } from '../lib/rate-limit';
import { parseJson } from '../lib/validate';

const MAX_ACTIVE_INVITES = 10;
const DAY = 24 * 60 * 60_000;

type InviteRow = {
  id: string;
  max_uses: number;
  use_count: number;
  expires_at: number;
  created_at: number;
};
const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  maxUses: r.max_uses,
  useCount: r.use_count,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

const ACTIVE = 'revoked_at IS NULL AND expires_at > ? AND use_count < max_uses';

export const invites = new Hono<AppEnv>()
  // Public: lets someone holding a code see who invited them before signing up.
  // Invalid, used and expired codes all return the same 404.
  .get('/preview', rateLimit(RULES.invitePreview), async (c) => {
    const parsed = InviteCode.safeParse(c.req.query('code') ?? '');
    if (!parsed.success) throw new ApiError('not_found', 'Invite not found');
    const row = await c.env.DB.prepare(
      `SELECT i.expires_at, u.display_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
       WHERE i.code_hash = ? AND i.revoked_at IS NULL AND i.expires_at > ? AND i.use_count < i.max_uses`,
    )
      .bind(await sha256Hex(parsed.data), Date.now())
      .first<{ expires_at: number; display_name: string | null }>();
    if (!row) throw new ApiError('not_found', 'Invite not found');
    return c.json<InvitePreview>({ inviterName: row.display_name, expiresAt: row.expires_at });
  })

  .use(requireAuth)
  .post('/', async (c) => {
    const { expiresInDays } = await parseJson(c, CreateInviteRequest);
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const now = Date.now();
    const active = await db
      .prepare(`SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND ${ACTIVE}`)
      .bind(userId, now)
      .first<{ n: number }>();
    if ((active?.n ?? 0) >= MAX_ACTIVE_INVITES) {
      throw new ApiError('rate_limited', `You can have at most ${MAX_ACTIVE_INVITES} open invites`);
    }
    // 12 Crockford chars = 60 bits; stored only as a hash, shown to the creator once.
    const code = randomCrockford(12);
    const row: InviteRow = {
      id: newId('inv'),
      max_uses: 1,
      use_count: 0,
      expires_at: now + expiresInDays * DAY,
      created_at: now,
    };
    await db.batch([
      db
        .prepare(
          'INSERT INTO invites (id, code_hash, created_by, max_uses, use_count, expires_at, created_at) VALUES (?, ?, ?, 1, 0, ?, ?)',
        )
        .bind(row.id, await sha256Hex(code), userId, row.expires_at, now),
      auditStatement(db, 'invite_created', { userId, deviceId }, { invite: row.id }),
    ]);
    return c.json<CreatedInvite>({ ...toInvite(row), code }, 201);
  })

  .get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, max_uses, use_count, expires_at, created_at FROM invites WHERE created_by = ? AND ${ACTIVE} ORDER BY created_at DESC`,
    )
      .bind(c.get('auth').userId, Date.now())
      .all<InviteRow>();
    return c.json<{ invites: Invite[] }>({ invites: results.map(toInvite) });
  })

  .delete('/:id', async (c) => {
    const { userId, deviceId } = c.get('auth');
    const db = c.env.DB;
    const id = c.req.param('id');
    const res = await db
      .prepare(
        'UPDATE invites SET revoked_at = ? WHERE id = ? AND created_by = ? AND revoked_at IS NULL',
      )
      .bind(Date.now(), id, userId)
      .run();
    if (res.meta.changes !== 1) throw new ApiError('not_found', 'Invite not found');
    await auditStatement(db, 'invite_revoked', { userId, deviceId }, { invite: id }).run();
    return c.json<OkResponse>({ ok: true });
  });
