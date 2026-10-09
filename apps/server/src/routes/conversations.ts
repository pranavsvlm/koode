import {
  AddMembersRequest,
  CreateConversationRequest,
  CreateEncryptedAttachmentRequest,
  ReceiptRequest,
  RenameGroupRequest,
  SendMessageRequest,
  UpdateMemberRequest,
  type StoredAttachment,
  type OkResponse,
  type ConversationSummary,
  type Message,
  type MessagePage,
} from '@koode/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import type { RoomResult } from '../durable-objects/conversation-room';
import { signalDeviceId } from '../keys/devices';
import { limitUser, RULES } from '../lib/rate-limit';
import { newId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { BODY_LIMITS, parseJson } from '../lib/validate';
import {
  hydrate,
  loadSummaries,
  MESSAGE_SELECT,
  notifyUsers,
  type MessageRow,
} from '../messaging/rows';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

function unwrap<T>(r: RoomResult<T>): T {
  if (!r.ok) throw new ApiError(r.code, r.message, r.details);
  return r.value;
}

const room = (env: Env, id: string) =>
  env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(id));

async function isMember(db: D1Database, conversationId: string, userId: string) {
  return !!(await db
    .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .bind(conversationId, userId)
    .first());
}

async function activeUsers(db: D1Database, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT id FROM users WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

function parseCursor(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ApiError('bad_request', 'Invalid cursor');
  return n;
}

export const conversations = new Hono<AppEnv>()
  .use(requireAuth)

  .get('/', async (c) =>
    c.json<{ conversations: ConversationSummary[] }>({
      conversations: await loadSummaries(c.env.DB, c.get('auth').userId),
    }),
  )

  .post('/', async (c) => {
    const req = await parseJson(c, CreateConversationRequest);
    const { userId } = c.get('auth');
    const db = c.env.DB;
    const now = Date.now();

    if (req.kind === 'direct') {
      if (req.userId === userId)
        throw new ApiError('bad_request', 'You can’t start a chat with yourself');
      if (!(await activeUsers(db, [req.userId])).has(req.userId))
        throw new ApiError('not_found', 'User not found');
      const directKey = [userId, req.userId].sort().join(':');
      const existing = await db
        .prepare('SELECT id FROM conversations WHERE direct_key = ?')
        .bind(directKey)
        .first<{ id: string }>();
      if (existing) return c.json((await loadSummaries(db, userId, existing.id))[0]!);

      const id = newId('cnv');
      try {
        await db.batch([
          db
            .prepare(
              "INSERT INTO conversations (id, kind, direct_key, created_by, created_at) VALUES (?, 'direct', ?, ?, ?)",
            )
            .bind(id, directKey, userId, now),
          db
            .prepare(
              'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?), (?, ?, ?)',
            )
            .bind(id, userId, now, id, req.userId, now),
        ]);
      } catch {
        // Both people started the chat at once: use the one that won.
        const winner = await db
          .prepare('SELECT id FROM conversations WHERE direct_key = ?')
          .bind(directKey)
          .first<{ id: string }>();
        if (!winner) throw new ApiError('internal', 'Could not create conversation');
        return c.json((await loadSummaries(db, userId, winner.id))[0]!);
      }
      c.executionCtx.waitUntil(
        notifyUsers(c.env, [userId, req.userId], { type: 'conversation', conversationId: id }),
      );
      return c.json((await loadSummaries(db, userId, id))[0]!, 201);
    }

    // Group: creator is admin; unknown or inactive members are rejected.
    const memberIds = [...new Set(req.memberIds.filter((m) => m !== userId))];
    if (memberIds.length === 0) throw new ApiError('bad_request', 'Add at least one other person');
    const found = await activeUsers(db, memberIds);
    if (found.size !== memberIds.length)
      throw new ApiError('not_found', 'Some people weren’t found');
    const id = newId('cnv');
    await db.batch([
      db
        .prepare(
          "INSERT INTO conversations (id, kind, title, created_by, created_at) VALUES (?, 'group', ?, ?, ?)",
        )
        .bind(id, req.title, userId, now),
      db
        .prepare(
          "INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)",
        )
        .bind(id, userId, now),
      ...memberIds.map((m) =>
        db
          .prepare(
            'INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
          )
          .bind(id, m, now),
      ),
    ]);
    // "Maya created the group": also tells every member about the new conversation.
    unwrap(await room(c.env, id).created({ conversationId: id, userId }));
    return c.json((await loadSummaries(db, userId, id))[0]!, 201);
  })

  .get('/:id', async (c) => {
    const [summary] = await loadSummaries(c.env.DB, c.get('auth').userId, c.req.param('id'));
    if (!summary) throw new ApiError('not_found', 'Conversation not found');
    return c.json<ConversationSummary>(summary);
  })

  /**
   * History, oldest first. `after=<seq>` pages forward; `changedSince=<rev>`
   * returns messages sent *or changed* (reactions, deletion) after a revision,
   * in revision order (catch-up); otherwise pages backward from `before=<seq>`
   * (default: newest).
   */
  .get('/:id/messages', async (c) => {
    const id = c.req.param('id');
    const db = c.env.DB;
    const { userId, deviceId } = c.get('auth');
    if (!(await isMember(db, id, userId)))
      throw new ApiError('not_found', 'Conversation not found');
    const after = parseCursor(c.req.query('after'));
    const before = parseCursor(c.req.query('before'));
    const changedSince = parseCursor(c.req.query('changedSince'));
    const limit = Math.min(
      Math.max(parseCursor(c.req.query('limit')) ?? PAGE_DEFAULT, 1),
      PAGE_MAX,
    );

    const query = (where: string, order: string, ...binds: unknown[]) =>
      db
        .prepare(
          `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND ${where} ORDER BY ${order} LIMIT ?`,
        )
        .bind(id, ...binds, limit + 1)
        .all<MessageRow>()
        .then((r) => r.results);

    let rows: MessageRow[];
    let forward = true;
    if (changedSince !== undefined) rows = await query('m.rev > ?', 'm.rev ASC', changedSince);
    else if (after !== undefined) rows = await query('m.seq > ?', 'm.seq ASC', after);
    else {
      forward = false;
      rows = (await query('m.seq < ?', 'm.seq DESC', before ?? Number.MAX_SAFE_INTEGER)).reverse();
    }

    const hasMore = rows.length > limit;
    const page = forward
      ? rows.slice(0, limit)
      : rows.slice(rows.length - Math.min(rows.length, limit));
    // Each device gets only its own ciphertexts.
    const reader = { userId, device: await signalDeviceId(db, deviceId) };
    return c.json<MessagePage>({ messages: await hydrate(db, page, reader), hasMore });
  })

  /**
   * Start an encrypted upload: the ciphertext goes to PUT
   * /v1/attachments/:id/content. What the file is travels in the message.
   */
  .post('/:id/attachments', async (c) => {
    const req = await parseJson(c, CreateEncryptedAttachmentRequest);
    const conversationId = c.req.param('id');
    const { userId } = c.get('auth');
    await limitUser(c.env, RULES.createAttachment, userId);
    const db = c.env.DB;
    if (!(await isMember(db, conversationId, userId)))
      throw new ApiError('not_found', 'Conversation not found');
    const meta: StoredAttachment = {
      id: newId('att'),
      kind: 'encrypted',
      mimeType: 'application/octet-stream',
      sizeBytes: req.sizeBytes,
      name: null,
      width: null,
      height: null,
      durationMs: null,
      waveform: null,
      preview: null,
      hasThumbnail: false,
    };
    await db
      .prepare(
        `INSERT INTO attachments (id, conversation_id, uploader_id, kind, mime_type, size_bytes, created_at)
         VALUES (?, ?, ?, 'encrypted', ?, ?, ?)`,
      )
      .bind(meta.id, conversationId, userId, meta.mimeType, meta.sizeBytes, Date.now())
      .run();
    return c.json<StoredAttachment>(meta, 201);
  })

  .post('/:id/messages', async (c) => {
    const req = await parseJson(c, SendMessageRequest, BODY_LIMITS.message);
    const { userId, deviceId } = c.get('auth');
    await limitUser(c.env, RULES.sendMessage, userId);
    const conversationId = c.req.param('id');
    const message = unwrap(
      await room(c.env, conversationId).post({
        conversationId,
        senderId: userId,
        senderDeviceId: deviceId,
        senderDevice: await signalDeviceId(c.env.DB, deviceId),
        id: req.id,
        kind: req.kind,
        envelopes: req.envelopes,
        attachmentId: req.attachmentId ?? null,
        targetId: req.targetId ?? null,
      }),
    );
    return c.json<Message>(message, 201);
  })

  /** Delete for everyone (sender, or a group admin). */
  .delete('/:id/messages/:messageId', async (c) => {
    const conversationId = c.req.param('id');
    return c.json<Message>(
      unwrap(
        await room(c.env, conversationId).remove({
          conversationId,
          userId: c.get('auth').userId,
          deviceId: c.get('auth').deviceId,
          messageId: c.req.param('messageId'),
        }),
      ),
    );
  })

  // ——— Group administration (admins; anyone may leave) ———

  .patch('/:id', async (c) => {
    const { title } = await parseJson(c, RenameGroupRequest);
    const conversationId = c.req.param('id');
    const { userId } = c.get('auth');
    unwrap(await room(c.env, conversationId).rename({ conversationId, userId, title }));
    return c.json<ConversationSummary>((await loadSummaries(c.env.DB, userId, conversationId))[0]!);
  })

  .post('/:id/members', async (c) => {
    const { userIds } = await parseJson(c, AddMembersRequest);
    const conversationId = c.req.param('id');
    const { userId } = c.get('auth');
    const ids = [...new Set(userIds)];
    if ((await activeUsers(c.env.DB, ids)).size !== ids.length)
      throw new ApiError('not_found', 'Some people weren’t found');
    unwrap(await room(c.env, conversationId).addMembers({ conversationId, userId, userIds: ids }));
    return c.json<ConversationSummary>((await loadSummaries(c.env.DB, userId, conversationId))[0]!);
  })

  .patch('/:id/members/:userId', async (c) => {
    const { role } = await parseJson(c, UpdateMemberRequest);
    const conversationId = c.req.param('id');
    const { userId } = c.get('auth');
    unwrap(
      await room(c.env, conversationId).setRole({
        conversationId,
        userId,
        targetId: c.req.param('userId'),
        role,
      }),
    );
    return c.json<ConversationSummary>((await loadSummaries(c.env.DB, userId, conversationId))[0]!);
  })

  /** Remove someone, or `DELETE …/members/<me>` to leave. */
  .delete('/:id/members/:userId', async (c) => {
    const conversationId = c.req.param('id');
    const { userId } = c.get('auth');
    unwrap(
      await room(c.env, conversationId).removeMember({
        conversationId,
        userId,
        targetId: c.req.param('userId'),
      }),
    );
    return c.json<OkResponse>({ ok: true });
  })

  .post('/:id/receipts', async (c) => {
    const req = await parseJson(c, ReceiptRequest);
    const conversationId = c.req.param('id');
    return c.json(
      unwrap(
        await room(c.env, conversationId).receipt({
          conversationId,
          userId: c.get('auth').userId,
          delivered: req.delivered,
          read: req.read,
          shareRead: req.shareRead,
        }),
      ),
    );
  });
