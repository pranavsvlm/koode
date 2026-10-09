/* eslint-disable @typescript-eslint/no-explicit-any -- recorded push payloads are asserted structurally */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { CallJoin, type AuthSession } from '@koode/shared';
import { importSPKI, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, openSocket, twoUsers, uuid } from './helpers';

const APP_ID = 'com.navoasis.koode.dev';
const hex = (c: string) => c.repeat(64);
const SETTINGS = { directMessages: true, groupMessages: true, calls: true, previews: true };

type Apns = { auth: string | null; body: Record<string, any> };
type Fcm = { auth: string | null; body: { message: Record<string, any> } };

/**
 * Outbound pushes are intercepted at `fetch` (tests run in the Worker's isolate):
 * the relay, Google's OAuth endpoint and FCM. Nothing leaves the machine.
 */
let apns: Apns[];
let fcm: Fcm[];
let oauth: URLSearchParams[];
let relayReply: (push: Record<string, any>) => { status: number; reason?: string };
let fcmReply: () => Response;

beforeEach(() => {
  apns = [];
  fcm = [];
  oauth = [];
  relayReply = () => ({ status: 200 });
  fcmReply = () => Response.json({ name: 'projects/koode-test/messages/1' });
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (req.url === 'https://relay.test/apns') {
      const body = await req.json<Record<string, any>>();
      apns.push({ auth: req.headers.get('authorization'), body });
      return Response.json(relayReply(body));
    }
    if (req.url === 'https://oauth2.googleapis.com/token') {
      oauth.push(new URLSearchParams(await req.text()));
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    if (req.url.startsWith('https://fcm.googleapis.com/')) {
      fcm.push({ auth: req.headers.get('authorization'), body: await req.json() });
      return fcmReply();
    }
    return real(input as RequestInfo, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const registerIos = (s: AuthSession, patch: Record<string, unknown> = {}) =>
  api('/push', {
    method: 'PUT',
    token: s.accessToken,
    body: {
      platform: 'ios',
      appId: APP_ID,
      environment: 'sandbox',
      alertToken: hex('a'),
      voipToken: hex('b'),
      settings: SETTINGS,
      ...patch,
    },
  });

async function registerAndroid(s: AuthSession, patch: Record<string, unknown> = {}) {
  await env.DB.prepare("UPDATE devices SET platform = 'android' WHERE id = ?")
    .bind(s.deviceId)
    .run();
  return api('/push', {
    method: 'PUT',
    token: s.accessToken,
    body: {
      platform: 'android',
      appId: APP_ID,
      alertToken: 'fcm-token:APA91b-test_token-0123456789',
      settings: SETTINGS,
      ...patch,
    },
  });
}

async function directChat(from: AuthSession, to: AuthSession) {
  return (
    await api('/conversations', {
      body: { kind: 'direct', userId: to.user.id },
      token: from.accessToken,
    })
  ).json.id as string;
}
const send = (s: AuthSession, conversationId: string, body: string) =>
  api(`/conversations/${conversationId}/messages`, {
    body: { id: uuid(), body },
    token: s.accessToken,
  });

const registration = (deviceId: string) =>
  env.DB.prepare('SELECT * FROM push_registrations WHERE device_id = ?')
    .bind(deviceId)
    .first<Record<string, unknown>>();

describe('registration', () => {
  it('stores this device’s tokens and settings', async () => {
    const { dan } = await twoUsers();
    expect((await registerIos(dan)).status).toBe(200);
    expect(await registration(dan.deviceId)).toMatchObject({
      user_id: dan.user.id,
      platform: 'ios',
      app_id: APP_ID,
      environment: 'sandbox',
      alert_token: hex('a'),
      voip_token: hex('b'),
      previews: 1,
    });
    // Re-registering updates in place.
    await registerIos(dan, { settings: { ...SETTINGS, previews: false }, voipToken: null });
    expect(await registration(dan.deviceId)).toMatchObject({ previews: 0, voip_token: null });
  });

  it('rejects unknown apps, the wrong platform and malformed tokens', async () => {
    const { dan } = await twoUsers();
    expect((await registerIos(dan, { appId: 'com.evil.app' })).status).toBe(400);
    expect((await registerIos(dan, { alertToken: 'nothex' })).status).toBe(400);
    expect(
      (
        await api('/push', {
          method: 'PUT',
          token: dan.accessToken,
          body: {
            platform: 'android',
            appId: APP_ID,
            alertToken: 'x'.repeat(40),
            settings: SETTINGS,
          },
        })
      ).status,
    ).toBe(400); // this device registered as iOS
    expect((await api('/push', { method: 'PUT', body: {} })).status).toBe(401);
  });

  it('moves a token to the newest device that registers it (one phone, new account)', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(maya);
    await registerIos(dan);
    expect(await registration(maya.deviceId)).toMatchObject({
      alert_token: null,
      voip_token: null,
    });
    expect(await registration(dan.deviceId)).toMatchObject({ alert_token: hex('a') });
  });

  it('is removed on sign-out and on request', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(maya);
    await registerIos(dan, { alertToken: hex('c'), voipToken: null });
    await api('/push', { method: 'DELETE', token: maya.accessToken });
    expect(await registration(maya.deviceId)).toBeNull();
    await api('/auth/logout', { body: {}, token: dan.accessToken });
    expect(await registration(dan.deviceId)).toBeNull();
  });
});

describe('message notifications', () => {
  it('alerts the recipient through the relay, never the sender', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(maya, { alertToken: hex('1'), voipToken: null });
    await registerIos(dan);
    const id = await directChat(maya, dan);
    await send(maya, id, 'Dinner at 7?');

    await vi.waitFor(() => expect(apns).toHaveLength(1));
    const [push] = apns;
    expect(push!.auth).toBe(`Bearer ${env.PUSH_RELAY_SECRET}`);
    expect(push!.body).toMatchObject({
      token: hex('a'),
      topic: APP_ID,
      environment: 'sandbox',
      pushType: 'alert',
      priority: 10,
      payload: {
        aps: {
          alert: { title: 'Maya Chen', body: 'Dinner at 7?' },
          'thread-id': id,
          badge: 1,
          category: 'message',
        },
        body: { type: 'message', conversationId: id },
      },
    });
  });

  it('hides the text when previews are off, and respects muted message types', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan, { settings: { ...SETTINGS, previews: false } });
    const id = await directChat(maya, dan);
    await send(maya, id, 'secret plans');
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    expect(apns[0]!.body.payload.aps.alert).toEqual({ title: 'Maya Chen', body: 'New message' });
    expect(JSON.stringify(apns[0]!.body)).not.toContain('secret plans');

    await registerIos(dan, { settings: { ...SETTINGS, directMessages: false } });
    await send(maya, id, 'again');
    await new Promise((r) => setTimeout(r, 200));
    expect(apns).toHaveLength(1);
  });

  it('names the group and the sender', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan);
    const group = await api('/conversations', {
      body: { kind: 'group', title: 'Family', memberIds: [dan.user.id] },
      token: maya.accessToken,
    });
    await send(maya, group.json.id, 'Hello all');
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    expect(apns[0]!.body.payload.aps.alert).toEqual({
      title: 'Family',
      body: 'Maya Chen: Hello all',
    });

    await registerIos(dan, { settings: { ...SETTINGS, groupMessages: false } });
    await send(maya, group.json.id, 'again');
    await new Promise((r) => setTimeout(r, 200));
    expect(apns).toHaveLength(1);
  });

  it('sends Android a data message via FCM, authenticated with a signed service-account assertion', async () => {
    const { maya, dan } = await twoUsers();
    expect((await registerAndroid(dan)).status).toBe(200);
    const id = await directChat(maya, dan);
    await send(maya, id, 'Hi Dan');

    await vi.waitFor(() => expect(fcm).toHaveLength(1));
    expect(fcm[0]!.auth).toBe('Bearer ya29.test');
    expect(fcm[0]!.body.message).toEqual({
      token: 'fcm-token:APA91b-test_token-0123456789',
      android: { priority: 'high', ttl: '86400s' },
      data: {
        title: 'Maya Chen',
        message: 'Hi Dan',
        channelId: 'messages',
        tag: id,
        badge: '1',
        body: expect.any(String),
      },
    });
    expect(JSON.parse(fcm[0]!.body.message.data.body)).toMatchObject({
      type: 'message',
      conversationId: id,
    });

    // The OAuth assertion is an RS256 JWT signed with the service account key.
    const assertion = oauth.at(-1)!.get('assertion')!;
    const { payload } = await jwtVerify(
      assertion,
      await importSPKI(env.TEST_FCM_PUBLIC_KEY, 'RS256'),
    );
    expect(payload).toMatchObject({
      iss: 'push@koode-test.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
  });

  it('forgets tokens that APNs or FCM report as dead', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan);
    relayReply = () => ({ status: 410, reason: 'Unregistered' });
    const id = await directChat(maya, dan);
    await send(maya, id, 'one');
    await vi.waitFor(async () =>
      expect((await registration(dan.deviceId))?.alert_token).toBeNull(),
    );
    expect((await registration(dan.deviceId))?.voip_token).toBe(hex('b')); // only the dead one

    await registerAndroid(maya);
    fcmReply = () =>
      Response.json(
        { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } },
        { status: 404 },
      );
    await send(dan, id, 'two');
    await vi.waitFor(async () =>
      expect((await registration(maya.deviceId))?.alert_token).toBeNull(),
    );
  });
});

describe('call notifications', () => {
  const start = (s: AuthSession, userId: string, kind: 'voice' | 'video' = 'voice') =>
    api('/calls', { body: { userId, kind }, token: s.accessToken });

  it('rings iOS through PushKit and Android through a high-priority data message', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan);
    const { call } = CallJoin.parse((await start(maya, dan.user.id, 'video')).json);
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    expect(apns[0]!.body).toMatchObject({
      token: hex('b'),
      topic: `${APP_ID}.voip`,
      pushType: 'voip',
      priority: 10,
      collapseId: call.id,
      expiration: Math.floor((call.createdAt + 45_000) / 1000),
      payload: {
        aps: {},
        body: {
          type: 'call',
          callId: call.id,
          callerId: maya.user.id,
          callerName: 'Maya Chen',
          kind: 'video',
        },
      },
    });
    await api(`/calls/${call.id}/end`, { body: {}, token: maya.accessToken });

    await registerAndroid(dan);
    const second = CallJoin.parse((await start(maya, dan.user.id)).json).call;
    await vi.waitFor(() => expect(fcm).toHaveLength(1));
    expect(fcm[0]!.body.message).toMatchObject({
      android: { priority: 'high', ttl: '45s' },
      data: {
        title: 'Maya Chen',
        message: 'Incoming voice call',
        channelId: 'calls',
        tag: second.id,
      },
    });
  });

  it('falls back to an alert when the device has no PushKit token', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan, { voipToken: null });
    await start(maya, dan.user.id);
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    expect(apns[0]!.body).toMatchObject({
      pushType: 'alert',
      payload: {
        aps: { alert: { title: 'Maya Chen', body: 'Incoming voice call' }, category: 'call' },
      },
    });
  });

  it('stops the ringing and leaves a missed-call notification when the caller gives up', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan);
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    await api(`/calls/${call.id}/end`, { body: {}, token: maya.accessToken });
    await vi.waitFor(() => expect(apns).toHaveLength(3));
    const [, ended, missed] = apns;
    expect(ended!.body).toMatchObject({
      pushType: 'voip',
      payload: { body: { type: 'call-ended', callId: call.id } },
    });
    expect(missed!.body).toMatchObject({
      pushType: 'alert',
      payload: {
        aps: { alert: { title: 'Maya Chen', body: 'Missed voice call' }, category: 'missed_call' },
        body: { type: 'missed-call', callId: call.id, callerId: maya.user.id },
      },
    });
  });

  it('does not notify the device that answered, and leaves no missed call', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan);
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    await vi.waitFor(() => expect(apns).toHaveLength(1));
    await api(`/calls/${call.id}/accept`, { body: {}, token: dan.accessToken });
    await api(`/calls/${call.id}/end`, { body: {}, token: dan.accessToken });
    await new Promise((r) => setTimeout(r, 200));
    expect(apns).toHaveLength(1);
  });

  it('marks unanswered calls missed at the ring timeout, even if the caller vanished', async () => {
    const { maya, dan } = await twoUsers();
    await registerAndroid(dan);
    const mayaSocket = await openSocket(maya.accessToken);
    await mayaSocket.next('ready');
    const { call } = CallJoin.parse((await start(maya, dan.user.id)).json);
    await mayaSocket.next('call');

    const timer = env.CALL_TIMER.get(env.CALL_TIMER.idFromName(call.id));
    expect(await runDurableObjectAlarm(timer)).toBe(true);

    expect((await api(`/calls/${call.id}`, { token: dan.accessToken })).json.state).toBe('missed');
    expect(((await mayaSocket.next('call'))?.call as { state: string }).state).toBe('missed');
    await vi.waitFor(() => expect(fcm).toHaveLength(2));
    expect(fcm[1]!.body.message.data).toMatchObject({
      title: 'Maya Chen',
      message: 'Missed voice call',
      channelId: 'missed-calls',
      tag: call.id, // replaces the ringing notification
    });
  });

  it('respects the calls setting', async () => {
    const { maya, dan } = await twoUsers();
    await registerIos(dan, { settings: { ...SETTINGS, calls: false } });
    await start(maya, dan.user.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(apns).toHaveLength(0);
  });
});
