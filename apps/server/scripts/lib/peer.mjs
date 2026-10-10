/**
 * A development peer: a real Koode account driven from Node against the local
 * server, with end-to-end encryption done by Signal's own Node library
 * (@signalapp/libsignal-client) and call media by LiveKit's Node SDK with frame
 * encryption. Used by the device-test scripts next to this folder, which pair
 * with the app's dev tours (EXPO_PUBLIC_DEV_TOUR).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as S from '@signalapp/libsignal-client';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';

export const base = 'http://localhost:8787/v1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log('[peer]', ...a);
export const devVars = Object.fromEntries(
  readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const B = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ——— HTTP and coordination ———

export async function call(path, body, token, method) {
  const res = await fetch(base + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok)
    throw Object.assign(new Error(`${path} → ${res.status} ${JSON.stringify(json)}`), {
      status: res.status,
      body: json,
    });
  return json;
}
export const raw = (path, token, init = {}) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

export async function waitFor(fn, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Follow the app's Metro log. The runners start a fresh Metro (and log) for
 * each run, so the whole file is this run's: reading from the start means a
 * line the app wrote while this script was still loading isn't missed.
 */
export function metro(path) {
  const start = 0;
  const text = () => readFileSync(path, 'utf8').slice(start);
  const waitForLog = (pattern, timeoutMs) =>
    waitFor(() => text().match(pattern), pattern, timeoutMs);
  return {
    waitForLog,
    /** `[tour-<tag>] <label> <json>` → the parsed JSON. */
    tourJson: async (tag, label, timeoutMs) =>
      JSON.parse((await waitForLog(new RegExp(`\\[tour-${tag}\\] ${label} (.*)`), timeoutMs))[1]),
    /** The account the app registered in this run. */
    appUser: async () => {
      const [, username, id] = await waitForLog(/\[tour-auth\] registered @(\S+) id=(usr_[\w-]+)/);
      return { username, id };
    },
  };
}

/** PASS/FAIL lines; `finish()` exits non-zero if anything failed. */
export function checks() {
  const results = [];
  return {
    check(name, ok, detail) {
      results.push(!!ok);
      const d =
        detail === undefined
          ? ''
          : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
      console.log(`[peer] ${ok ? 'PASS' : 'FAIL'} ${name}${d}`);
    },
    finish() {
      const passed = results.filter(Boolean).length;
      log(`${passed}/${results.length} checks passed`);
      process.exit(passed === results.length ? 0 : 1);
    },
  };
}

// ——— Files (libsignal's Aes256GcmEncryptedData layout: nonce ‖ ciphertext ‖ tag) ———

export function sealFile(plain) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
  return { sealed, key: b64(key), digest: createHash('sha256').update(sealed).digest('base64') };
}

export function openFile(sealed, secret) {
  if (createHash('sha256').update(sealed).digest('base64') !== secret.digest)
    throw new Error('digest mismatch');
  const d = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(secret.key, 'base64'),
    sealed.subarray(0, 12),
  );
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
}

export function jpegSize(buf) {
  for (let i = 2; i < buf.length;) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// ——— Signal protocol stores (in memory) ———

const addr = (a) => `${a.name()}.${a.deviceId()}`;
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function stores(identity, registrationId) {
  const sessions = new Map();
  const identities = new Map();
  const preKeys = new Map();
  const signed = new Map();
  const kyber = new Map();
  const lastResort = new Set();
  class Sessions extends S.SessionStore {
    async saveSession(a, r) {
      sessions.set(addr(a), r.serialize());
    }
    async getSession(a) {
      const b = sessions.get(addr(a));
      return b ? S.SessionRecord.deserialize(b) : null;
    }
    async getExistingSessions(as) {
      return Promise.all(as.map((a) => this.getSession(a)));
    }
  }
  class Identities extends S.IdentityKeyStore {
    async getIdentityKey() {
      return identity.privateKey;
    }
    async getLocalRegistrationId() {
      return registrationId;
    }
    async saveIdentity(a, k) {
      const old = identities.get(addr(a));
      identities.set(addr(a), k.serialize());
      return old && !same(old, k.serialize())
        ? S.IdentityChange.ReplacedExisting
        : S.IdentityChange.NewOrUnchanged;
    }
    async isTrustedIdentity(a, k) {
      const old = identities.get(addr(a));
      return !old || same(old, k.serialize());
    }
    async getIdentity(a) {
      const b = identities.get(addr(a));
      return b ? S.PublicKey.deserialize(b) : null;
    }
  }
  class PreKeys extends S.PreKeyStore {
    async savePreKey(id, r) {
      preKeys.set(id, r);
    }
    async getPreKey(id) {
      if (!preKeys.has(id)) throw new Error(`no prekey ${id}`);
      return preKeys.get(id);
    }
    async removePreKey(id) {
      preKeys.delete(id);
    }
  }
  class Signed extends S.SignedPreKeyStore {
    async saveSignedPreKey(id, r) {
      signed.set(id, r);
    }
    async getSignedPreKey(id) {
      if (!signed.has(id)) throw new Error(`no signed prekey ${id}`);
      return signed.get(id);
    }
  }
  class Kyber extends S.KyberPreKeyStore {
    async saveKyberPreKey(id, r) {
      kyber.set(id, r);
    }
    async getKyberPreKey(id) {
      if (!kyber.has(id)) throw new Error(`no kyber prekey ${id}`);
      return kyber.get(id);
    }
    async markKyberPreKeyUsed(id) {
      if (!lastResort.has(id)) kyber.delete(id);
    }
  }
  return {
    sessions: new Sessions(),
    identities: new Identities(),
    preKeys: new PreKeys(),
    signed: new Signed(),
    kyber: new Kyber(),
    lastResort,
  };
}

// ——— A peer ———

/** Register an account with an invite, publish real keys and return its handle. */
export async function createPeer({ invite, name, displayName }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const { nonce } = await call('/auth/challenge', { purpose: 'register' });
  const session = await call('/auth/register', {
    inviteCode: invite.replace(/-/g, ''),
    username: `${name}${randomInt(1e5)}`,
    displayName,
    recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
    device: { name: 'Node peer', platform: 'ios', signingPublicKey: pub },
    nonce,
    signature: sign(
      null,
      Buffer.from(`koode-auth-v1\nregister\n${nonce}\n${pub}`),
      privateKey,
    ).toString('base64url'),
  });
  const token = session.accessToken;
  const user = session.user;

  // Real keys: signed EC prekey, last-resort Kyber, one-time EC and Kyber prekeys.
  const identity = S.IdentityKeyPair.generate();
  const registrationId = 1 + randomInt(16000);
  const st = stores(identity, registrationId);
  const now = Date.now();
  const signedBy = (bytes) => identity.privateKey.sign(bytes);
  const spk = S.PrivateKey.generate();
  await st.signed.saveSignedPreKey(
    1,
    S.SignedPreKeyRecord.new(
      1,
      now,
      spk.getPublicKey(),
      spk,
      signedBy(spk.getPublicKey().serialize()),
    ),
  );
  const last = S.KEMKeyPair.generate();
  await st.kyber.saveKyberPreKey(
    1000,
    S.KyberPreKeyRecord.new(1000, now, last, signedBy(last.getPublicKey().serialize())),
  );
  st.lastResort.add(1000);
  const preKeys = [];
  const kyberPreKeys = [];
  for (let id = 1; id <= 20; id++) {
    const k = S.PrivateKey.generate();
    await st.preKeys.savePreKey(id, S.PreKeyRecord.new(id, k.getPublicKey(), k));
    preKeys.push({ keyId: id, publicKey: b64(k.getPublicKey().serialize()) });
    const kem = S.KEMKeyPair.generate();
    const sig = signedBy(kem.getPublicKey().serialize());
    await st.kyber.saveKyberPreKey(id, S.KyberPreKeyRecord.new(id, now, kem, sig));
    kyberPreKeys.push({
      keyId: id,
      publicKey: b64(kem.getPublicKey().serialize()),
      signature: b64(sig),
    });
  }
  await call(
    '/keys',
    {
      registrationId,
      identityKey: b64(identity.publicKey.serialize()),
      signedPreKey: {
        keyId: 1,
        publicKey: b64(spk.getPublicKey().serialize()),
        signature: b64(signedBy(spk.getPublicKey().serialize())),
      },
      kyberPreKey: {
        keyId: 1000,
        publicKey: b64(last.getPublicKey().serialize()),
        signature: b64(signedBy(last.getPublicKey().serialize())),
      },
      preKeys,
      kyberPreKeys,
    },
    token,
    'PUT',
  );
  const deviceId = (await call('/keys/status', null, token)).deviceId;
  const local = S.ProtocolAddress.new(user.id, deviceId);
  log(`${displayName} is @${user.username} (${user.id}.${deviceId})`);

  async function encryptFor(userIds, plain) {
    const { devices } = await call(`/keys/devices?userIds=${userIds.join(',')}`, null, token);
    const out = [];
    for (const d of devices) {
      if (d.userId === user.id && d.deviceId === deviceId) continue;
      const to = S.ProtocolAddress.new(d.userId, d.deviceId);
      if (!(await st.sessions.getSession(to))) {
        const {
          bundles: [b],
        } = await call(`/keys/${d.userId}/${d.deviceId}`, null, token);
        const bundle = S.PreKeyBundle.new(
          b.registrationId,
          b.deviceId,
          b.preKey ? b.preKey.keyId : null,
          b.preKey ? S.PublicKey.deserialize(B(b.preKey.publicKey)) : null,
          b.signedPreKey.keyId,
          S.PublicKey.deserialize(B(b.signedPreKey.publicKey)),
          B(b.signedPreKey.signature),
          S.PublicKey.deserialize(B(b.identityKey)),
          b.kyberPreKey.keyId,
          S.KEMPublicKey.deserialize(B(b.kyberPreKey.publicKey)),
          B(b.kyberPreKey.signature),
        );
        await S.processPreKeyBundle(bundle, to, local, st.sessions, st.identities);
      }
      const ct = await S.signalEncrypt(
        new Uint8Array(Buffer.from(plain, 'utf8')),
        to,
        local,
        st.sessions,
        st.identities,
      );
      out.push({
        userId: d.userId,
        deviceId: d.deviceId,
        type: ct.type(),
        body: b64(ct.serialize()),
      });
    }
    return out;
  }

  async function decrypt(senderId, senderDevice, env) {
    const from = S.ProtocolAddress.new(senderId, senderDevice);
    const data = B(env.body);
    const plain =
      env.type === 3
        ? await S.signalDecryptPreKey(
            S.PreKeySignalMessage.deserialize(data),
            from,
            local,
            st.sessions,
            st.identities,
            st.preKeys,
            st.signed,
            st.kyber,
          )
        : await S.signalDecrypt(
            S.SignalMessage.deserialize(data),
            from,
            local,
            st.sessions,
            st.identities,
          );
    return JSON.parse(Buffer.from(plain).toString('utf8'));
  }

  const membersOf = async (conversationId) =>
    (await call(`/conversations/${conversationId}`, null, token)).members.map((m) => m.userId);

  /** My profile photo key, sent with every message (as the app does). */
  let profile = null;

  /** Send a payload as an encrypted message (re-encrypting if devices changed). */
  async function send(conversationId, kind, content, extra = {}) {
    const id = randomUUID();
    const payload = { v: 1, id, conversationId, ...(profile && { profile }), t: kind, ...content };
    for (let attempt = 1; ; attempt++) {
      try {
        const envelopes = await encryptFor(
          await membersOf(conversationId),
          JSON.stringify(payload),
        );
        const message = await call(
          `/conversations/${conversationId}/messages`,
          { id, kind, envelopes, ...extra },
          token,
        );
        return { message, payload };
      } catch (e) {
        if (e.status !== 409 || !e.body?.error?.details || attempt >= 3) throw e;
      }
    }
  }

  // Each message is decrypted once (the ratchet allows nothing else).
  const opened = new Map();

  const peer = {
    user,
    token,
    deviceId,
    identityKey: identity.publicKey,
    encryptFor,
    decrypt,

    /** A direct chat, once the other person's device has published its keys. */
    async chatWith(userId) {
      await waitFor(
        async () => (await call(`/keys/devices?userIds=${userId}`, null, token)).devices.length > 0,
        `${userId}'s keys`,
        60_000,
      );
      return (await call('/conversations', { kind: 'direct', userId }, token)).id;
    },

    sendText: (conversationId, body, replyToId = null) =>
      send(conversationId, 'text', { body, replyToId }),

    react: (conversationId, targetId, emoji) =>
      send(conversationId, 'reaction', { targetId, emoji }, { targetId }),

    /** Encrypt and upload a file (and optional poster), then send it. */
    async sendFile(conversationId, data, meta, poster) {
      const content = sealFile(data);
      const thumb = poster ? sealFile(poster) : null;
      const stored = await call(
        `/conversations/${conversationId}/attachments`,
        { sizeBytes: content.sealed.length },
        token,
      );
      const put = async (part, body) => {
        const res = await raw(`/attachments/${stored.id}/${part}`, token, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
          },
          body,
        });
        if (!res.ok) throw new Error(`upload ${part} → ${res.status}`);
      };
      if (thumb) await put('thumbnail', thumb.sealed);
      await put('content', content.sealed);
      return send(
        conversationId,
        'attachment',
        {
          body: meta.caption ?? '',
          replyToId: null,
          attachment: {
            kind: meta.kind,
            mimeType: meta.mimeType,
            sizeBytes: data.length,
            name: meta.name ?? null,
            width: meta.width ?? null,
            height: meta.height ?? null,
            durationMs: meta.durationMs ?? null,
            waveform: meta.waveform ?? null,
            preview: meta.preview ?? null,
            content: { key: content.key, digest: content.digest },
            thumbnail: thumb ? { key: thumb.key, digest: thumb.digest } : null,
          },
        },
        { attachmentId: stored.id },
      );
    },

    /**
     * The conversation's messages, each with its decrypted payload `p` (or
     * `error`). Messages this device wrote, deleted ones and system notes have
     * neither.
     */
    async history(conversationId) {
      const { messages } = await call(
        `/conversations/${conversationId}/messages?limit=100`,
        null,
        token,
      );
      for (const m of messages) {
        if (opened.has(m.id) || m.deletedAt || m.encryption !== 'signal') continue;
        const env = m.envelopes.find((e) => e.deviceId === deviceId);
        if (!env) continue;
        try {
          opened.set(m.id, { p: await decrypt(m.senderId, m.senderDevice, env) });
        } catch (e) {
          opened.set(m.id, { error: String(e) });
        }
      }
      return messages.map((m) => ({ m, ...opened.get(m.id) }));
    },

    /** Set my profile photo: encrypted here, ciphertext uploaded, key sent with my messages. */
    async setPhoto(jpeg) {
      const { sealed, key, digest } = sealFile(jpeg);
      const res = await raw('/me/avatar', token, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: sealed,
      });
      if (!res.ok) throw new Error(`avatar upload → ${res.status}`);
      const { avatarId } = await res.json();
      profile = { avatar: { id: avatarId, content: { key, digest } } };
      return profile;
    },

    /** Download and decrypt someone's profile photo (key from their message). */
    async downloadPhoto(userId, avatar) {
      const res = await raw(`/users/${userId}/avatar/${avatar.id}`, token);
      if (!res.ok) return { status: res.status };
      const sealed = Buffer.from(await res.arrayBuffer());
      return { status: res.status, sealed, plain: openFile(sealed, avatar.content) };
    },

    /** Download and decrypt an attachment's content or poster. */
    async download(attachmentId, secret, part = 'content') {
      const res = await raw(`/attachments/${attachmentId}/${part}`, token);
      if (!res.ok) return { status: res.status, res };
      const sealed = Buffer.from(await res.arrayBuffer());
      return { status: res.status, res, sealed, plain: openFile(sealed, secret) };
    },

    /** Call someone: a fresh media key, encrypted to their devices. */
    async startCall(userId, kind) {
      const uuid = randomUUID();
      const mediaKey = b64(randomBytes(32));
      const plain = JSON.stringify({ v: 1, t: 'call', callId: `cal_${uuid}`, key: mediaKey });
      const join = await call(
        '/calls',
        { id: uuid, userId, kind, envelopes: await encryptFor([userId], plain) },
        token,
      );
      return { ...join, mediaKey };
    },

    /** Answer a call: decrypt the media key and check it names this call. */
    async acceptCall(callId) {
      const join = await call(`/calls/${callId}/accept`, {}, token);
      const key = await decrypt(join.call.callerId, join.key.senderDevice, join.key.envelope);
      if (key.t !== 'call' || key.callId !== join.call.id) throw new Error('call key mismatch');
      return { ...join, mediaKey: key.key };
    },

    /**
     * Join a call's media with frame encryption, publishing a 440 Hz tone and
     * measuring the decoded audio of `listenTo`.
     */
    async joinMedia(join, { listenTo } = {}) {
      return joinRoom(join.media.url, join.media.token, B(join.mediaKey), { listenTo, tone: true });
    },
  };
  return peer;
}

/** A LiveKit room member: optional tone; decoded audio energy from one person. */
export async function joinRoom(url, token, sharedKey, { listenTo, tone = false } = {}) {
  const room = new Room();
  let frames = 0;
  let energy = 0;
  room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || (listenTo && participant.identity !== listenTo))
      return;
    for await (const frame of new AudioStream(track)) {
      frames++;
      for (const s of frame.data) energy += Math.abs(s);
      if (frames > 3000) break;
    }
  });
  await room.connect(url, token, {
    autoSubscribe: true,
    dynacast: false,
    encryption: { keyProviderOptions: { sharedKey } },
  });
  let timer = null;
  if (tone) {
    const source = new AudioSource(48000, 1);
    await room.localParticipant.publishTrack(
      LocalAudioTrack.createAudioTrack('mic', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    let t = 0;
    timer = setInterval(() => {
      const data = new Int16Array(480);
      for (let i = 0; i < 480; i++, t++)
        data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * t) / 48000));
      void source.captureFrame(new AudioFrame(data, 48000, 1, 480)).catch(() => {});
    }, 10);
  }
  return {
    room,
    heard: () => ({ frames, energy }),
    async leave() {
      if (timer) clearInterval(timer);
      await room.disconnect();
    },
  };
}

/** Join a call's room as someone else (development LiveKit keys), e.g. an eavesdropper. */
export async function joinAs(identity, roomName, url, sharedKey, listenTo) {
  const t = new AccessToken(devVars.LIVEKIT_API_KEY, devVars.LIVEKIT_API_SECRET, { identity });
  t.addGrant({ room: roomName, roomJoin: true, canPublish: false, canSubscribe: true });
  return joinRoom(url, await t.toJwt(), sharedKey, { listenTo });
}
