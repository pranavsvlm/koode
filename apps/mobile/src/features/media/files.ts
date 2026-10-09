import type { AttachmentMeta } from '@koode/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { authClient } from '@/features/auth';
import { ApiClientError } from '@/lib/api';
import { env } from '@/lib/env';
import type { LocalUpload } from '@/features/messaging/types';

/**
 * Files on the device:
 *  - outbox/: copies of files being sent (Documents, so a pending send
 *    survives restarts and low-storage purges);
 *  - media/: downloaded attachments, by attachment id (Caches: the system
 *    may purge them; they are downloaded again when needed).
 * Contents are plaintext until end-to-end encryption (Phase 8).
 */
const outbox = () => ensureDir(new Directory(Paths.document, 'outbox'));
const media = () => ensureDir(new Directory(Paths.cache, 'media'));

function ensureDir(d: Directory): Directory {
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
};
const extFor = (a: Pick<AttachmentMeta, 'mimeType' | 'name'>) =>
  EXT[a.mimeType] ?? a.name?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin';

/** Copy a picked/recorded/processed file into the outbox. */
export async function toOutbox(sourceUri: string, ext: string): Promise<string> {
  const target = new File(outbox(), `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await new File(sourceUri).copy(target);
  return target.uri;
}

export const fileSize = (uri: string) => new File(uri).size ?? 0;

const contentFile = (a: Pick<AttachmentMeta, 'id' | 'mimeType' | 'name'>) =>
  new File(media(), `${a.id}.${extFor(a)}`);
const posterFile = (id: string) => new File(media(), `${id}.poster.jpg`);

/** The local copy, if this device has one. */
export function cachedUri(a: Pick<AttachmentMeta, 'id' | 'mimeType' | 'name'>): string | null {
  const f = contentFile(a);
  return f.exists ? f.uri : null;
}
export function cachedPosterUri(id: string): string | null {
  const f = posterFile(id);
  return f.exists ? f.uri : null;
}

const inflight = new Map<string, Promise<string>>();

/** Download (once, with my credentials) and return the local file. */
export function download(
  a: Pick<AttachmentMeta, 'id' | 'mimeType' | 'name'>,
  part: 'content' | 'thumbnail' = 'content',
): Promise<string> {
  const file = part === 'content' ? contentFile(a) : posterFile(a.id);
  if (file.exists) return Promise.resolve(file.uri);
  const key = `${part}:${a.id}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const token = await authClient.getAccessToken();
    // Download beside the target, then move: a half-written file never looks cached.
    const partial = new File(media(), `${a.id}.${part}.partial`);
    if (partial.exists) partial.delete();
    await File.downloadFileAsync(
      `${env.apiUrl}/v1/attachments/${encodeURIComponent(a.id)}/${part}`,
      partial,
      { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
    );
    // The sender's own copy may have been moved into place meanwhile.
    if (file.exists) partial.delete();
    else await partial.move(file);
    return file.uri;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/** PUT a local file as an attachment's content or poster. */
export async function upload(
  attachmentId: string,
  part: 'content' | 'thumbnail',
  file: { uri: string; mimeType: string },
  onProgress: (fraction: number) => void,
): Promise<void> {
  const token = await authClient.getAccessToken();
  const result = await new File(file.uri).upload(
    `${env.apiUrl}/v1/attachments/${encodeURIComponent(attachmentId)}/${part}`,
    {
      httpMethod: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.mimeType },
      mimeType: file.mimeType,
      onProgress: (p) => p.totalBytes > 0 && onProgress(p.bytesSent / p.totalBytes),
    },
  );
  if (result.status >= 200 && result.status < 300) return;
  let code: ApiClientError['code'] = 'internal';
  let message = `Upload failed (${result.status})`;
  try {
    const body = JSON.parse(result.body) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code as ApiClientError['code'];
    if (body.error?.message) message = body.error.message;
  } catch {
    // keep defaults
  }
  if (result.status === 401) code = 'unauthorized';
  throw new ApiClientError(code, message, result.status);
}

/** After sending: keep the outbox file as the cached copy (no re-download). */
export function adoptUploaded(u: LocalUpload, attachment: AttachmentMeta) {
  try {
    const target = contentFile(attachment);
    if (!target.exists) new File(u.uri).moveSync(target);
    if (u.posterUri) {
      const poster = posterFile(attachment.id);
      if (!poster.exists) new File(u.posterUri).moveSync(poster);
    }
  } catch {
    // only an optimisation
  }
  discardFiles(u);
}

/** Remove a pending upload's files. */
export function discardFiles(u: Pick<LocalUpload, 'uri' | 'posterUri'>) {
  for (const uri of [u.uri, u.posterUri]) {
    if (!uri) continue;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  }
}

/** Sign-out: nothing from the account stays on the device. */
export function clearMediaFiles() {
  for (const d of [new Directory(Paths.document, 'outbox'), new Directory(Paths.cache, 'media')]) {
    try {
      if (d.exists) d.delete();
    } catch {
      // best effort
    }
  }
}
