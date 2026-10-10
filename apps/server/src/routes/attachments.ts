import {
  ENCRYPTION_OVERHEAD,
  IMAGE_TYPES,
  THUMBNAIL_LIMIT,
  VIDEO_TYPES,
  VOICE_TYPES,
  type OkResponse,
} from '@koode/shared';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/middleware';
import { ApiError } from '../lib/errors';
import { contentKey, thumbnailKey } from '../media/storage';

type AttachmentRow = {
  id: string;
  conversation_id: string;
  uploader_id: string;
  message_id: string | null;
  kind: 'image' | 'video' | 'document' | 'voice' | 'encrypted';
  mime_type: string;
  size_bytes: number;
  name: string | null;
  has_thumbnail: number;
  uploaded_at: number | null;
};

/** Types safe to render inline; everything else is served as a download. */
const INLINE = new Set([...IMAGE_TYPES, ...VIDEO_TYPES, ...VOICE_TYPES]);

/** My own upload that hasn't been sent yet (uploads can be retried until then). */
async function ownUnsent(db: D1Database, id: string, userId: string): Promise<AttachmentRow> {
  const a = await db
    .prepare('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?')
    .bind(id, userId)
    .first<AttachmentRow>();
  if (!a) throw new ApiError('not_found', 'Attachment not found');
  if (a.message_id !== null) throw new ApiError('conflict', 'Attachment was already sent');
  return a;
}

/**
 * Readable by current members of its conversation once sent, and by the
 * uploader before that. Everyone else (including people removed from the
 * group) gets the same 404 as a missing file.
 */
async function readable(db: D1Database, id: string, userId: string): Promise<AttachmentRow> {
  const a = await db
    .prepare(
      `SELECT a.* FROM attachments a
       JOIN conversation_members cm ON cm.conversation_id = a.conversation_id AND cm.user_id = ?
       WHERE a.id = ? AND a.uploaded_at IS NOT NULL AND (a.message_id IS NOT NULL OR a.uploader_id = ?)`,
    )
    .bind(userId, id, userId)
    .first<AttachmentRow>();
  if (!a) throw new ApiError('not_found', 'Attachment not found');
  return a;
}

/** Streams the request body into R2, insisting on the declared length. */
export async function store(
  c: Context<AppEnv>,
  key: string,
  expected: { size?: number; max: number; contentType: string },
): Promise<R2Object> {
  const length = Number(c.req.header('content-length'));
  if (!Number.isInteger(length) || length <= 0)
    throw new ApiError('bad_request', 'Content-Length is required');
  if (length > expected.max) throw new ApiError('bad_request', 'File is too large');
  if (expected.size !== undefined && length !== expected.size)
    throw new ApiError('bad_request', 'File size doesn’t match the attachment');
  const body = c.req.raw.body;
  if (!body) throw new ApiError('bad_request', 'Missing file');
  const object = await c.env.MEDIA.put(key, body, {
    httpMetadata: { contentType: expected.contentType },
  });
  if (!object || object.size !== length) {
    await c.env.MEDIA.delete(key);
    throw new ApiError('bad_request', 'Upload was incomplete');
  }
  return object;
}

/** Serves an R2 object with Range support (video players request ranges). */
async function serve(c: Context<AppEnv>, key: string, a: AttachmentRow, contentType: string) {
  const object = await c.env.MEDIA.get(key, {
    range: c.req.raw.headers,
    onlyIf: c.req.raw.headers,
  });
  if (!object) throw new ApiError('not_found', 'Attachment not found');
  const headers = new Headers({
    'content-type': contentType,
    etag: object.httpEtag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    // Never rendered by a browser as a page, even if opened directly.
    'content-security-policy': "default-src 'none'; sandbox",
  });
  if (a.kind === 'document' || a.kind === 'encrypted') {
    headers.set(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(a.name ?? 'file')}`,
    );
  }
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  const r = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  // R2 reports a range even for plain reads; only answer 206 to a Range request.
  if (r && c.req.header('range') && (r.offset !== undefined || r.suffix !== undefined)) {
    const offset = r.suffix !== undefined ? object.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix ?? r.length ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

export const attachments = new Hono<AppEnv>()
  .use(requireAuth)

  .put('/:id/content', async (c) => {
    const a = await ownUnsent(c.env.DB, c.req.param('id'), c.get('auth').userId);
    await store(c, contentKey(a.conversation_id, a.id), {
      size: a.size_bytes,
      max: a.size_bytes,
      contentType: a.mime_type,
    });
    await c.env.DB.prepare('UPDATE attachments SET uploaded_at = ? WHERE id = ?')
      .bind(Date.now(), a.id)
      .run();
    return c.json<OkResponse>({ ok: true });
  })

  /** Video poster: an encrypted JPEG (the server can't tell what the file is). */
  .put('/:id/thumbnail', async (c) => {
    const a = await ownUnsent(c.env.DB, c.req.param('id'), c.get('auth').userId);
    if (a.kind !== 'encrypted') throw new ApiError('bad_request', 'Upload an encrypted file');
    if (c.req.header('content-type') !== 'application/octet-stream')
      throw new ApiError('bad_request', 'Thumbnails must be encrypted');
    await store(c, thumbnailKey(a.conversation_id, a.id), {
      max: THUMBNAIL_LIMIT + ENCRYPTION_OVERHEAD,
      contentType: 'application/octet-stream',
    });
    await c.env.DB.prepare('UPDATE attachments SET has_thumbnail = 1 WHERE id = ?')
      .bind(a.id)
      .run();
    return c.json<OkResponse>({ ok: true });
  })

  .get('/:id/content', async (c) => {
    const a = await readable(c.env.DB, c.req.param('id'), c.get('auth').userId);
    // Ciphertext (and legacy documents) are only ever opaque downloads.
    const type =
      a.kind !== 'document' && a.kind !== 'encrypted' && INLINE.has(a.mime_type)
        ? a.mime_type
        : 'application/octet-stream';
    return serve(c, contentKey(a.conversation_id, a.id), a, type);
  })

  .get('/:id/thumbnail', async (c) => {
    const a = await readable(c.env.DB, c.req.param('id'), c.get('auth').userId);
    if (!a.has_thumbnail) throw new ApiError('not_found', 'No thumbnail');
    return a.kind === 'encrypted'
      ? serve(c, thumbnailKey(a.conversation_id, a.id), a, 'application/octet-stream')
      : serve(c, thumbnailKey(a.conversation_id, a.id), { ...a, kind: 'image' }, 'image/jpeg');
  });
