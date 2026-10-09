import { env } from 'cloudflare:test';
import {
  CallJoin,
  DeviceMismatch,
  KeyDeviceList,
  KeyStatus,
  Message,
  MessagePage,
  PreKeyBundleList,
  type AuthSession,
} from '@koode/shared';
import { describe, expect, it } from 'vitest';
import {
  api,
  envelopesFor,
  myDevice,
  opened,
  openSocket,
  publishKeys,
  registerUser,
  secondDevice,
  seedInvite,
  sendMessage,
  startCall,
  twoUsers,
  uuid,
} from './helpers';

const status = async (s: AuthSession) =>
  KeyStatus.parse((await api('/keys/status', { token: s.accessToken })).json);
const bundles = async (s: AuthSession, userId: string, device?: number) =>
  api(`/keys/${userId}${device ? `/${device}` : ''}`, { token: s.accessToken });

async function directChat(a: AuthSession, b: AuthSession) {
  return (
    await api('/conversations', {
      body: { kind: 'direct', userId: b.user.id },
      token: a.accessToken,
    })
  ).json.id as string;
}

/** Someone signed up whose device hasn't published keys yet. */
async function registerAndKeys() {
  await seedInvite('FRESHPERS0N1');
  const maya = (await registerUser({ inviteCode: 'FRESHPERS0N1', username: 'fresh' })).session;
  return { maya };
}

describe('key directory', () => {
  it('numbers each account’s devices 1, 2, 3 …', async () => {
    const { maya } = await twoUsers();
    expect(await myDevice(maya.accessToken)).toBe(1);
    const ipad = await secondDevice('maya');
    expect(await myDevice(ipad.accessToken)).toBe(2);
    // A revoked device's number is never reused (peers may hold sessions for it).
    await api(`/devices/${ipad.deviceId}`, { method: 'DELETE', token: maya.accessToken });
    expect(await myDevice((await secondDevice('maya')).accessToken)).toBe(3);
  });

  it('keeps a device’s identity key fixed, and audits attempts to change it', async () => {
    const { maya } = await twoUsers();
    const before = await status(maya);
    expect(before).toMatchObject({ published: true, preKeys: 2, kyberPreKeys: 2 });
    const res = await publishKeys(maya.accessToken);
    expect(res.status).toBe(409);
    expect((await status(maya)).identityKey).toBe(before.identityKey);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE event = 'identity_key_rejected' AND user_id = ?",
    )
      .bind(maya.user.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
    // Re-publishing with the same identity rotates prekeys.
    expect(
      (
        await publishKeys(maya.accessToken, {
          identityKey: before.identityKey!,
          registrationId: (await env.DB.prepare(
            'SELECT registration_id FROM signal_keys WHERE device_id = ?',
          )
            .bind(maya.deviceId)
            .first<{ registration_id: number }>())!.registration_id,
          preKeys: 0,
          kyberPreKeys: 0,
        })
      ).status,
    ).toBe(200);
  });

  it('hands out each one-time key once, then falls back to the last-resort key', async () => {
    const { maya, dan } = await twoUsers();
    const take = async () =>
      PreKeyBundleList.parse((await bundles(dan, maya.user.id)).json).bundles[0]!;
    const first = await take();
    const second = await take();
    expect(first).toMatchObject({ userId: maya.user.id, deviceId: 1 });
    expect(first.preKey?.keyId).toBe(1);
    expect(second.preKey?.keyId).toBe(2);
    expect(first.kyberPreKey.keyId).toBe(1);
    expect(second.kyberPreKey.keyId).toBe(2);
    const third = await take();
    expect(third.preKey).toBeNull();
    expect(third.kyberPreKey.keyId).toBe(1000); // last resort
    expect(await status(maya)).toMatchObject({ preKeys: 0, kyberPreKeys: 0 });

    // The device tops up.
    const more = await api('/keys/one-time', {
      token: maya.accessToken,
      body: { preKeys: [{ keyId: 3, publicKey: btoa('x'.repeat(33)) }] },
    });
    expect(more.status).toBe(200);
    expect((await take()).preKey?.keyId).toBe(3);
  });

  it('takes a full first publish at real key sizes, but not oversized bodies', async () => {
    const { maya } = await registerAndKeys();
    const kyber = (keyId: number) => ({
      keyId,
      publicKey: btoa('k'.repeat(1569)), // Kyber-1024 public key
      signature: btoa('s'.repeat(64)),
    });
    const res = await api('/keys', {
      method: 'PUT',
      token: maya.accessToken,
      body: {
        registrationId: 7,
        identityKey: btoa('i'.repeat(33)),
        signedPreKey: {
          keyId: 1,
          publicKey: btoa('p'.repeat(33)),
          signature: btoa('s'.repeat(64)),
        },
        kyberPreKey: kyber(1000),
        preKeys: Array.from({ length: 100 }, (_, i) => ({
          keyId: i + 1,
          publicKey: btoa('e'.repeat(33)),
        })),
        kyberPreKeys: Array.from({ length: 100 }, (_, i) => kyber(i + 1)),
      },
    });
    expect(res.status).toBe(200);
    // Ordinary routes keep the small limit.
    const big = await api('/me', {
      method: 'PATCH',
      token: maya.accessToken,
      body: { about: 'x'.repeat(20_000) },
    });
    expect(big.status).toBe(400);
    expect(big.json.error.message).toBe('Request body too large');
  });

  it('caps one-time keys and validates key material', async () => {
    const { maya } = await twoUsers();
    const many = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ keyId: from + i, publicKey: btoa('y'.repeat(33)) }));
    const up = (preKeys: unknown[]) =>
      api('/keys/one-time', { token: maya.accessToken, body: { preKeys } });
    expect((await up(many(10, 100))).status).toBe(200);
    expect((await up(many(200, 99))).status).toBe(400); // 2 + 100 + 99 > 200
    expect((await up([{ keyId: 9, publicKey: 'not base64!' }])).status).toBe(400);
    expect((await up([{ keyId: 0, publicKey: btoa('z') }])).status).toBe(400);
  });

  it('lists only active devices with keys, and needs sign-in', async () => {
    const { maya, dan } = await twoUsers();
    const ipad = await secondDevice('maya'); // no keys yet
    const list = async () =>
      KeyDeviceList.parse(
        (await api(`/keys/devices?userIds=${maya.user.id}`, { token: dan.accessToken })).json,
      ).devices.map((d) => d.deviceId);
    expect(await list()).toEqual([1]);
    await publishKeys(ipad.accessToken);
    expect(await list()).toEqual([1, 2]);
    await api(`/devices/${ipad.deviceId}`, { method: 'DELETE', token: maya.accessToken });
    expect(await list()).toEqual([1]);
    expect((await api(`/keys/devices?userIds=${maya.user.id}`)).status).toBe(401);
    expect((await bundles(dan, 'usr_nobody')).status).toBe(404);
    expect((await bundles(dan, maya.user.id, 2)).status).toBe(404); // revoked
  });
});

describe('sending to devices', () => {
  it('requires exactly one envelope per current device, except the sender’s', async () => {
    const { maya, dan } = await twoUsers();
    const danIpad = await secondDevice('dan');
    await publishKeys(danIpad.accessToken);
    const mayaIpad = await secondDevice('maya');
    await publishKeys(mayaIpad.accessToken);
    const id = await directChat(maya, dan);

    const all = await envelopesFor(maya, [maya.user.id, dan.user.id], 'hi');
    expect(
      all.map((e) => `${e.userId === dan.user.id ? 'dan' : 'maya'}.${e.deviceId}`).sort(),
    ).toEqual(['dan.1', 'dan.2', 'maya.2']);
    const post = (envelopes: unknown[]) =>
      api(`/conversations/${id}/messages`, {
        token: maya.accessToken,
        body: { id: uuid(), kind: 'text', envelopes },
      });

    const missing = await post(all.slice(1));
    expect(missing.status).toBe(409);
    expect(DeviceMismatch.parse(missing.json.error.details)).toEqual({
      missing: [{ userId: all[0]!.userId, deviceId: all[0]!.deviceId }],
      extra: [],
      unkeyed: [],
    });
    const self = { ...all[0]!, userId: maya.user.id, deviceId: 1 };
    const extra = await post([...all, self, all[1]]);
    expect(extra.status).toBe(409);
    expect(DeviceMismatch.parse(extra.json.error.details).extra).toHaveLength(2); // own device + duplicate
    expect((await post([...all, { ...all[0]!, deviceId: 9 }])).status).toBe(409); // unknown device

    expect((await post(all)).status).toBe(201);
  });

  it('gives each device only its own envelope', async () => {
    const { maya, dan } = await twoUsers();
    const danIpad = await secondDevice('dan');
    await publishKeys(danIpad.accessToken);
    const id = await directChat(maya, dan);
    const danSocket = await openSocket(dan.accessToken);
    await danSocket.next('ready');

    const sent = Message.parse((await sendMessage(maya, id, 'for each device')).json);
    // History: per device.
    for (const [s, device] of [
      [dan, 1],
      [danIpad, 2],
    ] as const) {
      const page = MessagePage.parse(
        (await api(`/conversations/${id}/messages`, { token: s.accessToken })).json,
      );
      expect(page.messages[0]!.envelopes.map((e) => e.deviceId)).toEqual([device]);
      expect(opened(page.messages[0]!)).toBe('for each device');
    }
    // Realtime: per person (each device picks its own).
    const live = (await danSocket.next('message'))?.message as Message;
    expect(live.id).toBe(sent.id);
    expect(live.envelopes.map((e) => e.deviceId).sort()).toEqual([1, 2]);
    // Maya's own (only) device got nothing: it wrote the message.
    const mine = MessagePage.parse(
      (await api(`/conversations/${id}/messages`, { token: maya.accessToken })).json,
    );
    expect(mine.messages[0]!.envelopes).toEqual([]);
    expect(sent.senderDevice).toBe(1);
  });

  it('stops addressing a removed group member at once', async () => {
    const { maya, dan } = await twoUsers();
    await seedInvite('THRDPERS0N01');
    const sam = (await registerUser({ inviteCode: 'THRDPERS0N01', username: 'sam' })).session;
    await publishKeys(sam.accessToken);
    const g = (
      await api('/conversations', {
        body: { kind: 'group', title: 'G', memberIds: [dan.user.id, sam.user.id] },
        token: maya.accessToken,
      })
    ).json.id as string;
    const stale = await envelopesFor(maya, [maya.user.id, dan.user.id, sam.user.id], 'x');
    await api(`/conversations/${g}/members/${sam.user.id}`, {
      method: 'DELETE',
      token: maya.accessToken,
    });
    const res = await api(`/conversations/${g}/messages`, {
      token: maya.accessToken,
      body: { id: uuid(), kind: 'text', envelopes: stale },
    });
    expect(res.status).toBe(409);
    expect(DeviceMismatch.parse(res.json.error.details).extra).toEqual([
      { userId: sam.user.id, deviceId: 1 },
    ]);
  });
});

describe('recipients without keys', () => {
  it('refuses a message nobody could read', async () => {
    const { maya } = await twoUsers();
    await seedInvite('THRDPERS0N03');
    const zoe = (await registerUser({ inviteCode: 'THRDPERS0N03', username: 'zoe' })).session;
    const id = await directChat(maya, zoe);
    const res = await sendMessage(maya, id, 'hello?');
    expect(res.status).toBe(409);
    expect(DeviceMismatch.parse(res.json.error.details).unkeyed).toEqual([zoe.user.id]);
    await publishKeys(zoe.accessToken);
    expect((await sendMessage(maya, id, 'hello!')).status).toBe(201);
  });
});

describe('call media keys', () => {
  it('go to exactly the callee’s devices; the answering device gets its own', async () => {
    const { maya, dan } = await twoUsers();
    const danIpad = await secondDevice('dan');
    await publishKeys(danIpad.accessToken);

    const id = uuid();
    const wrong = await api('/calls', {
      token: maya.accessToken,
      body: {
        id,
        userId: dan.user.id,
        kind: 'voice',
        envelopes: (await envelopesFor(maya, [dan.user.id], 'k')).slice(1),
      },
    });
    expect(wrong.status).toBe(409);

    const started = CallJoin.parse((await startCall(maya, dan.user.id)).json);
    expect(started.call.id).toMatch(/^cal_[0-9a-f-]{36}$/);
    expect(started.key).toBeNull(); // the caller made the key
    const answered = CallJoin.parse(
      (await api(`/calls/${started.call.id}/accept`, { body: {}, token: danIpad.accessToken }))
        .json,
    );
    expect(answered.key).toMatchObject({ senderDevice: 1, envelope: { deviceId: 2 } });
    expect(opened({ envelopes: [answered.key!.envelope] })).toBe('media-key');
  });

  it('can’t be sent to someone without keys, or reuse a call id', async () => {
    const { maya } = await twoUsers();
    await seedInvite('THRDPERS0N02');
    const eve = (await registerUser({ inviteCode: 'THRDPERS0N02', username: 'eve' })).session;
    expect((await startCall(maya, eve.user.id)).status).toBe(400);
    await publishKeys(eve.accessToken);
    const id = uuid();
    const body = {
      id,
      userId: eve.user.id,
      kind: 'voice',
      envelopes: await envelopesFor(maya, [eve.user.id], 'k'),
    };
    expect((await api('/calls', { token: maya.accessToken, body })).status).toBe(201);
    await api(`/calls/cal_${id}/end`, { body: {}, token: maya.accessToken });
    expect((await api('/calls', { token: maya.accessToken, body })).status).toBe(409);
  });
});

describe('abuse limits', () => {
  it('rate-limits message floods per user', async () => {
    const { maya, dan } = await twoUsers();
    const id = await directChat(maya, dan);
    const envelopes = await envelopesFor(maya, [maya.user.id, dan.user.id], 'x');
    let status = 0;
    for (let i = 0; i < 121 && status !== 429; i++)
      status = (
        await api(`/conversations/${id}/messages`, {
          token: maya.accessToken,
          body: { id: uuid(), kind: 'text', envelopes },
        })
      ).status;
    expect(status).toBe(429);
    // Others are unaffected.
    expect((await sendMessage(dan, id, 'still fine')).status).toBe(201);
  });
});
