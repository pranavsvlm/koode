import { useEffect, useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { authClient } from '@/features/auth';
import { decryptFile } from '@/features/crypto';
import { env } from '@/lib/env';
import type { AvatarPhoto } from '@/domain/types';

/**
 * Profile photos: ciphertext on the server, the key inside the owner's
 * messages. Each photo is downloaded once, checked against its digest,
 * decrypted into the cache (avatars/<avatar id>.jpg) and shown from there.
 */
const dir = () => {
  const d = new Directory(Paths.cache, 'avatars');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};
export const photoFile = (avatarId: string) => new File(dir(), `${avatarId}.jpg`);

type State = { uri: string } | 'loading' | 'failed';
const states = new Map<string, State>();
const listeners = new Set<() => void>();
const set = (id: string, s: State) => {
  states.set(id, s);
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The decrypted photo on this device, if it's there. */
function cached(photo: AvatarPhoto): string | null {
  const s = states.get(photo.id);
  if (s && typeof s === 'object') return s.uri;
  const f = photoFile(photo.id);
  return f.exists ? f.uri : null;
}

async function fetchPhoto(photo: AvatarPhoto): Promise<void> {
  if (states.get(photo.id) === 'loading') return;
  set(photo.id, 'loading');
  const target = photoFile(photo.id);
  const partial = new File(dir(), `${photo.id}.partial`);
  const plain = new File(dir(), `${photo.id}.plain`);
  try {
    const token = await authClient.getAccessToken();
    if (partial.exists) partial.delete();
    await File.downloadFileAsync(
      `${env.apiUrl}/v1/users/${encodeURIComponent(photo.userId)}/avatar/${encodeURIComponent(photo.id)}`,
      partial,
      { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
    );
    await decryptFile(partial.uri, plain.uri, photo.content); // checks the digest
    if (!target.exists) await plain.move(target);
    set(photo.id, { uri: target.uri });
  } catch {
    if (plain.exists) plain.delete(); // altered or truncated: never shown
    set(photo.id, 'failed');
  } finally {
    if (partial.exists) partial.delete();
  }
}

/** Put my own new photo in place (it's already on the device). */
export async function adoptMyPhoto(avatarId: string, plainUri: string): Promise<void> {
  const target = photoFile(avatarId);
  if (!target.exists) await new File(plainUri).copy(target);
  set(avatarId, { uri: target.uri });
}

/** A local file for the photo, downloading and decrypting it the first time. */
export function usePhotoUri(photo: AvatarPhoto | undefined): string | null {
  const id = photo?.id;
  const uri = useSyncExternalStore(subscribe, () => (photo ? cached(photo) : null));
  useEffect(() => {
    if (!photo || cached(photo) || states.get(photo.id) === 'failed') return;
    void fetchPhoto(photo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return uri;
}

/** Sign-out: no photos stay on the device. */
export function clearPhotos() {
  states.clear();
  try {
    const d = new Directory(Paths.cache, 'avatars');
    if (d.exists) d.delete();
  } catch {
    // best effort
  }
  listeners.forEach((l) => l());
}
