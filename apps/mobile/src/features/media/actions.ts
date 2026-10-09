import { Directory, File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import type { Attachment } from '@/domain/types';
import { cachedUri, download } from './files';
import { remoteOf } from './useMedia';

export class MediaActionError extends Error {}

/** The attachment as a local file (downloading it if needed). */
export async function localFile(a: Attachment): Promise<string> {
  if (a.localUri) return a.localUri;
  const remote = remoteOf(a);
  if (!remote) throw new MediaActionError('This file isn’t available.');
  return cachedUri(remote) ?? (await download(remote));
}

/** Save a photo or video to the library (asks for add-only access). */
export async function saveToPhotos(a: Attachment): Promise<void> {
  if (a.kind !== 'image' && a.kind !== 'video')
    throw new MediaActionError('Only photos and videos can be saved to Photos.');
  const permission = await requestPermissionsAsync(
    true,
    a.kind === 'video' ? ['video'] : ['photo'],
  );
  if (!permission.granted)
    throw new MediaActionError('Allow Koode to add to your photos in Settings to save this.');
  await Asset.create(await localFile(a));
}

/**
 * Share or open a file with another app. Documents are shared under their
 * real name (cached files are named by attachment id).
 */
export async function shareFile(a: Attachment): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new MediaActionError('Sharing isn’t available.');
  let uri = await localFile(a);
  if (a.kind === 'document') {
    const dir = new Directory(Paths.cache, 'share');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const named = new File(dir, a.name.replace(/[/\\]/g, '_'));
    if (named.exists) named.delete();
    await new File(uri).copy(named);
    uri = named.uri;
  }
  await Sharing.shareAsync(uri, { mimeType: a.mimeType, dialogTitle: 'Share' });
}
