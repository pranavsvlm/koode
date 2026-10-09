import { env } from 'cloudflare:test';
import { Call, CallJoin } from '@koode/shared';
import { jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { api, openSocket, registerUser, seedInvite, startCall, twoUsers } from './helpers';

const start = startCall;

describe('starting a call', () => {
  it('rings the callee and returns a room-scoped media token', async () => {
    const { maya, dan } = await twoUsers();
    const danSocket = await openSocket(dan.accessToken);
    await danSocket.next('ready');

    const res = await start(maya, dan.user.id, 'video');
    expect(res.status).toBe(201);
    const { call, media } = CallJoin.parse(res.json);
    expect(call).toMatchObject({
      kind: 'video',
      state: 'ringing',
      callerId: maya.user.id,
      calleeId: dan.user.id,
    });
    expect(media.url).toBe(env.LIVEKIT_URL);

    // The token is signed with the server-side secret and grants only this room.
    const { payload } = await jwtVerify(
      media.token,
      new TextEncoder().encode(env.LIVEKIT_API_SECRET),
    );
    expect(payload).toMatchObject({
      iss: env.LIVEKIT_API_KEY,
      sub: maya.user.id,
      name: 'Maya Chen',
    });
    expect(payload.video).toMatchObject({ room: call.id, roomJoin: true, canPublishData: false });
    expect((payload.video as Record<string, unknown>).roomAdmin).toBeUndefined();
    expect(JSON.stringify(res.json)).not.toContain(`"${env.LIVEKIT_API_SECRET}"`);

    const event = await danSocket.next('call');
    expect((event?.call as Call).id).toBe(call.id);
  });

  it('rejects calling yourself or unknown people', async () => {
    const { maya } = await twoUsers();
    expect((await start(maya, maya.user.id)).status).toBe(400);
    expect((await start(maya, 'usr_nobody')).status).toBe(404);
  });

  it('reports busy when either person is already in a call', async () => {
    const { maya, dan } = await twoUsers();
    await start(maya, dan.user.id);
    expect((await start(dan, maya.user.id)).status).toBe(409);
  });
});

describe('answering and hanging up', () => {
  it('lets only the callee accept, once, with their own token', async () => {
    const { maya, dan } = await twoUsers();
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    expect(
      (await api(`/calls/${call.id}/accept`, { body: {}, token: maya.accessToken })).status,
    ).toBe(403);

    const accepted = await api(`/calls/${call.id}/accept`, { body: {}, token: dan.accessToken });
    expect(accepted.status).toBe(200);
    const join = CallJoin.parse(accepted.json);
    expect(join.call.state).toBe('active');
    expect(join.call.answeredAt).toBeGreaterThan(0);
    const { payload } = await jwtVerify(
      join.media.token,
      new TextEncoder().encode(env.LIVEKIT_API_SECRET),
    );
    expect(payload.sub).toBe(dan.user.id);

    expect(
      (await api(`/calls/${call.id}/accept`, { body: {}, token: dan.accessToken })).status,
    ).toBe(409);
  });

  it('records declined, cancelled and ended outcomes', async () => {
    const { maya, dan } = await twoUsers();
    const c1 = CallJoin.parse((await start(maya, dan.user.id)).json).call;
    expect(
      (await api(`/calls/${c1.id}/decline`, { body: {}, token: dan.accessToken })).json.state,
    ).toBe('declined');

    const c2 = CallJoin.parse((await start(maya, dan.user.id)).json).call;
    expect(
      (await api(`/calls/${c2.id}/end`, { body: {}, token: maya.accessToken })).json.state,
    ).toBe('cancelled');

    const c3 = CallJoin.parse((await start(maya, dan.user.id)).json).call;
    await api(`/calls/${c3.id}/accept`, { body: {}, token: dan.accessToken });
    const ended = Call.parse(
      (await api(`/calls/${c3.id}/end`, { body: {}, token: dan.accessToken })).json,
    );
    expect(ended.state).toBe('ended');
    expect(ended.endedAt).toBeGreaterThanOrEqual(ended.answeredAt!);
    // Idempotent: hanging up again changes nothing.
    expect((await api(`/calls/${c3.id}/end`, { body: {}, token: maya.accessToken })).json).toEqual(
      ended,
    );
    expect(
      (await api(`/calls/${c3.id}/rejoin`, { body: {}, token: maya.accessToken })).status,
    ).toBe(409);
  });

  it('notifies the caller when the callee answers and when the call ends', async () => {
    const { maya, dan } = await twoUsers();
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    await mayaSocket.next('call'); // own ringing event (other devices)
    await api(`/calls/${call.id}/accept`, { body: {}, token: dan.accessToken });
    expect(((await mayaSocket.next('call'))?.call as Call).state).toBe('active');
    await api(`/calls/${call.id}/end`, { body: {}, token: dan.accessToken });
    expect(((await mayaSocket.next('call'))?.call as Call).state).toBe('ended');
  });

  it('marks unanswered calls missed after the ring timeout', async () => {
    const { maya, dan } = await twoUsers();
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    await env.DB.prepare('UPDATE calls SET created_at = created_at - 120000 WHERE id = ?')
      .bind(call.id)
      .run();
    expect((await api(`/calls/${call.id}`, { token: dan.accessToken })).json.state).toBe('missed');
    expect(
      (await api(`/calls/${call.id}/accept`, { body: {}, token: dan.accessToken })).status,
    ).toBe(409);
    // No longer busy.
    expect((await start(dan, maya.user.id)).status).toBe(201);
  });
});

describe('history and access', () => {
  it('lists only my calls, newest first, and hides others’ calls', async () => {
    const { maya, dan } = await twoUsers();
    const first = CallJoin.parse((await start(maya, dan.user.id)).json).call;
    await api(`/calls/${first.id}/end`, { body: {}, token: maya.accessToken });
    const second = CallJoin.parse((await start(dan, maya.user.id, 'video')).json).call;

    const list = (await api('/calls', { token: maya.accessToken })).json.calls as Call[];
    expect(list.map((c) => c.id)).toEqual([second.id, first.id]);

    await seedInvite('THRDCAQQER00');
    const eve = await registerUser({ inviteCode: 'THRDCAQQER00', username: 'eve' });
    expect((await api('/calls', { token: eve.session.accessToken })).json.calls).toEqual([]);
    expect((await api(`/calls/${second.id}`, { token: eve.session.accessToken })).status).toBe(404);
    expect(
      (await api(`/calls/${second.id}/end`, { body: {}, token: eve.session.accessToken })).status,
    ).toBe(404);
  });
});
