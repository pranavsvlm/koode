import { UserDirectory } from '@koode/shared';
import { describe, expect, it } from 'vitest';
import { api, openSocket, registerUser, twoUsers } from './helpers';

const directory = async (token: string) =>
  UserDirectory.parse((await api('/users', { token })).json).users;

const chat = (from: { accessToken: string }, userId: string) =>
  api('/conversations', { body: { kind: 'direct', userId }, token: from.accessToken });

describe('presence', () => {
  it('shows people I chat with online, then when they were last seen', async () => {
    const { maya, dan } = await twoUsers();
    await chat(maya, dan.user.id);
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');

    const danSocket = await openSocket(dan.accessToken);
    await danSocket.next('ready');
    expect(await mayaSocket.next('presence')).toMatchObject({
      userId: dan.user.id,
      online: true,
    });
    expect((await directory(maya.accessToken)).find((u) => u.id === dan.user.id)).toMatchObject({
      online: true,
    });

    danSocket.ws!.close(1000, 'bye');
    const offline = await mayaSocket.next('presence');
    expect(offline).toMatchObject({ userId: dan.user.id, online: false });
    expect(typeof offline!.lastSeenAt).toBe('number');
    const listed = (await directory(maya.accessToken)).find((u) => u.id === dan.user.id)!;
    expect(listed.online).toBe(false);
    expect(listed.lastSeenAt).toBe(offline!.lastSeenAt);
  });

  it('is hidden from people I don’t chat with', async () => {
    const { maya } = await twoUsers();
    const invite = await api('/invites', { body: {}, token: maya.accessToken });
    const sam = (await registerUser({ inviteCode: invite.json.code, username: 'sam' })).session;
    const samSocket = await openSocket(sam.accessToken);
    await samSocket.next('ready');
    const listed = (await directory(maya.accessToken)).find((u) => u.id === sam.user.id)!;
    expect(listed).toBeDefined();
    expect(listed.online).toBeUndefined();
    expect(listed.lastSeenAt).toBeUndefined();
  });

  it('“Nobody” hides mine, and hides everyone else’s from me', async () => {
    const { maya, dan } = await twoUsers();
    await chat(maya, dan.user.id);
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');
    const danSocket = await openSocket(dan.accessToken);
    await danSocket.next('ready');
    await mayaSocket.next('presence');

    expect(
      (await api('/me', { method: 'PATCH', body: { lastSeen: 'nobody' }, token: dan.accessToken }))
        .status,
    ).toBe(200);
    // Maya's app is told there's nothing to show any more.
    expect(await mayaSocket.next('presence')).toMatchObject({
      userId: dan.user.id,
      online: false,
      lastSeenAt: null,
    });
    const hidden = (await directory(maya.accessToken)).find((u) => u.id === dan.user.id)!;
    expect(hidden.online).toBeUndefined();
    // …and Dan no longer sees Maya's.
    const fromDan = (await directory(dan.accessToken)).find((u) => u.id === maya.user.id)!;
    expect(fromDan.online).toBeUndefined();
    // No more presence events about him.
    danSocket.ws!.close(1000, 'bye');
    expect(await mayaSocket.next('presence', 500)).toBeNull();
  });
});
