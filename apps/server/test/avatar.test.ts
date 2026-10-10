import { env, SELF } from 'cloudflare:test';
import { AVATAR_LIMIT, AvatarUploadResponse } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import { api, twoUsers } from './helpers';

const put = (token: string, bytes: Uint8Array<ArrayBuffer>, type = 'application/octet-stream') =>
  SELF.fetch('https://api.test/v1/me/avatar', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': type,
      'content-length': String(bytes.length),
    },
    body: bytes,
  });

const get = (token: string, userId: string, avatarId: string) =>
  SELF.fetch(`https://api.test/v1/users/${userId}/avatar/${avatarId}`, {
    headers: { authorization: `Bearer ${token}` },
  });

const objects = async (userId: string) =>
  (await env.MEDIA.list({ prefix: `avatar/${userId}/` })).objects.map((o) => o.key);

describe('profile photos', () => {
  it('stores encrypted photos only, and serves the current one to members', async () => {
    const { maya, dan } = await twoUsers();
    const photo = crypto.getRandomValues(new Uint8Array(1000));

    // Only opaque bytes (a JPEG would mean the app didn't encrypt it), within the limit.
    expect((await put(maya.accessToken, photo, 'image/jpeg')).status).toBe(400);
    expect((await put(maya.accessToken, new Uint8Array(AVATAR_LIMIT + 1))).status).toBe(400);

    const first = await put(maya.accessToken, photo);
    expect(first.status).toBe(200);
    const { avatarId } = AvatarUploadResponse.parse(await first.json());

    const fetched = await get(dan.accessToken, maya.user.id, avatarId);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(photo);
    expect((await get('nope', maya.user.id, avatarId)).status).toBe(401);

    // A new photo replaces the old one, which is deleted.
    const second = AvatarUploadResponse.parse(
      await (await put(maya.accessToken, photo.slice(0, 500))).json(),
    );
    expect(second.avatarId).not.toBe(avatarId);
    expect((await get(dan.accessToken, maya.user.id, avatarId)).status).toBe(404);
    expect(await objects(maya.user.id)).toEqual([`avatar/${maya.user.id}/${second.avatarId}`]);

    // Removing it.
    expect((await api('/me/avatar', { method: 'DELETE', token: maya.accessToken })).status).toBe(
      200,
    );
    expect((await get(dan.accessToken, maya.user.id, second.avatarId)).status).toBe(404);
    expect(await objects(maya.user.id)).toEqual([]);
  });

  it('is deleted with the account', async () => {
    const { maya, dan } = await twoUsers();
    const { avatarId } = AvatarUploadResponse.parse(
      await (await put(maya.accessToken, new Uint8Array(100))).json(),
    );
    await api('/me', { method: 'DELETE', body: { confirm: 'DELETE' }, token: maya.accessToken });
    expect(await objects(maya.user.id)).toEqual([]);
    expect((await get(dan.accessToken, maya.user.id, avatarId)).status).toBe(404);
  });
});
