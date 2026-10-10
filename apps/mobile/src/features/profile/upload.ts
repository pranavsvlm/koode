import { AVATAR_PIXELS, AvatarUploadResponse, OkResponse } from '@koode/shared';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { authClient } from '@/features/auth';
import { encryptFile } from '@/features/crypto';
import { ApiClientError } from '@/lib/api';
import { env } from '@/lib/env';
import { useChat } from '@/stores/chat';
import { adoptMyPhoto } from './photos';

const remove = (f: File) => {
  try {
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
};

/**
 * Set my profile photo: a centred square, resized to 512 px and re-encoded as
 * JPEG (dropping EXIF such as location), encrypted on this device with a fresh
 * key and uploaded. The key goes out with my next messages.
 */
export async function setProfilePhoto(picked: { uri: string; width: number; height: number }) {
  const side = Math.min(picked.width, picked.height);
  if (!side) throw new Error('That photo couldn’t be read.');
  const ref = await ImageManipulator.manipulate(picked.uri)
    .crop({
      originX: Math.round((picked.width - side) / 2),
      originY: Math.round((picked.height - side) / 2),
      width: side,
      height: side,
    })
    .resize({ width: AVATAR_PIXELS, height: AVATAR_PIXELS })
    .renderAsync();
  const jpeg = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  const plain = new File(jpeg.uri);
  const sealed = new File(Paths.cache, `avatar-${Date.now()}.sealed`);
  try {
    const secret = await encryptFile(plain.uri, sealed.uri);
    const token = await authClient.getAccessToken();
    const result = await sealed.upload(`${env.apiUrl}/v1/me/avatar`, {
      httpMethod: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      mimeType: 'application/octet-stream',
    });
    if (result.status < 200 || result.status >= 300)
      throw new ApiClientError('internal', `Upload failed (${result.status})`, result.status);
    const { avatarId } = AvatarUploadResponse.parse(JSON.parse(result.body));
    await adoptMyPhoto(avatarId, plain.uri);
    useChat.getState().setMyProfile({
      avatar: { id: avatarId, content: { key: secret.key, digest: secret.digest } },
    });
  } finally {
    remove(sealed);
    remove(plain);
  }
}

/** Remove my profile photo (people see my initials after my next message). */
export async function removeProfilePhoto() {
  await authClient.request('/v1/me/avatar', OkResponse, { method: 'DELETE' });
  useChat.getState().setMyProfile({ avatar: null });
}
