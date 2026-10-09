import type { AttachmentMeta, FileSecret } from '@koode/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { authClient } from '@/features/auth';
import { decryptFile, encryptFile } from '@/features/crypto';
import { ApiClientError } from '@/lib/api';
import { env } from '@/lib/env';
import type { LocalAttachment, LocalUpload, SealedFile } from '@/features/messaging/types';

/**
 * Files on the device:
 *  - outbox/: copies of files being sent (Documents, so a pending send
 *    survives restarts and low-storage purges);
 *  - media/: downloaded attachments, by attachment id (Caches: the system
 *    may purge them; they are downloaded again when needed).
 * The server only ever has ciphertext: files are encrypted into the outbox
 * before upload and decrypted after download (checking the digest first).
 * Local copies are plaintext, under the platform's file protection.
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

/** Encrypt an outbox file for upload, next to it (fresh key per file). */
export async function sealFile(uri: string): Promise<SealedFile> {
  const target = new File(outbox(), `${new File(uri).name}.sealed`);
  if (target.exists) target.delete();
  const secret = await encryptFile(uri, target.uri);
  return { ...secret, uri: target.uri };
}

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

/**
 * Download (once, with my credentials) and return the local file; encrypted
 * attachments are checked and decrypted on the way in.
 */
export function download(
  a: Pick<AttachmentMeta, 'id' | 'mimeType' | 'name'> & { secret?: LocalAttachment['secret'] },
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
    const secret: FileSecret | null | undefined =
      part === 'content' ? a.secret?.content : a.secret?.thumbnail;
    if (a.secret && !secret) throw new Error('Missing file key');
    // The sender's own copy may have been moved into place meanwhile.
    if (file.exists) partial.delete();
    else if (secret) {
      const plain = new File(media(), `${a.id}.${part}.plain`);
      try {
        await decryptFile(partial.uri, plain.uri, secret);
      } catch (e) {
        if (plain.exists) plain.delete(); // altered or truncated: never cached
        throw e;
      } finally {
        partial.delete();
      }
      // (A moved File object points at its new place, so nothing touches it after.)
      if (file.exists) plain.delete();
      else await plain.move(file);
    } else await partial.move(file);
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
  discardFiles({ uri: u.sealed?.uri ?? '', posterUri: u.posterSealed?.uri ?? null });
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

/** Remove a pending upload's files (and their encrypted copies). */
export function discardFiles(
  u: Pick<LocalUpload, 'uri' | 'posterUri'> & Partial<Pick<LocalUpload, 'sealed' | 'posterSealed'>>,
) {
  for (const uri of [u.uri, u.posterUri, u.sealed?.uri, u.posterSealed?.uri]) {
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
  // Images are shown from memory only, but clear expo-image's caches to be sure.
  void Image.clearMemoryCache();
  void Image.clearDiskCache();
  for (const d of [new Directory(Paths.document, 'outbox'), new Directory(Paths.cache, 'media')]) {
    try {
      if (d.exists) d.delete();
    } catch {
      // best effort
    }
  }
}
