#!/usr/bin/env node
/**
 * End-to-end encryption interoperability check, paired with the app's E2EE
 * tour (EXPO_PUBLIC_DEV_TOUR=e2ee). Plays "Maya" with Signal's own Node
 * library (@signalapp/libsignal-client), a second implementation alongside
 * the app's Swift one, against the local server:
 *
 *   node scripts/e2ee-peer.mjs <maya-invite> <metro-log> <media-dir>
 *
 *  1. publishes real PQXDH keys and sends the app an encrypted text and an
 *     encrypted photo; the app reports what it decrypted;
 *  2. decrypts the app's text, photo (digest checked) and reaction, and
 *     reacts back;
 *  3. compares safety numbers computed independently on both sides;
 *  4. answers the app's call, decrypts the media key, joins LiveKit with
 *     frame encryption and checks audio decrypts; an eavesdropper with the
 *     wrong key can't decrypt, and LiveKit reports the tracks as encrypted.
 *
 * Prints PASS/FAIL per check; exits non-zero on any failure.
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
import { join } from 'node:path';
import * as S from '@signalapp/libsignal-client';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  EncryptionState,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const [code, metroLog, mediaDir] = process.argv.slice(2);
const base = 'http://localhost:8787/v1';
const log = (...a) => console.log('[peer]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logStart = readFileSync(metroLog, 'utf8').length;
const devVars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(
    `[peer] ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  );
}

async function call(path, body, token, method) {
  const res = await fetch(base + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function waitFor(fn, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitForLog = (pattern, timeoutMs) =>
  waitFor(() => readFileSync(metroLog, 'utf8').slice(logStart).match(pattern), pattern, timeoutMs);
const tourJson = async (label) =>
  JSON.parse((await waitForLog(new RegExp(`\\[tour-e2ee\\] ${label} (.*)`)))[1]);

const B = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ——— Signal protocol stores (in memory) ———

const key = (a) => `${a.name()}.${a.deviceId()}`;
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function stores(identity, registrationId) {
  const sessionsMap = new Map();
  const identitiesMap = new Map();
  const preKeysMap = new Map();
  const signedMap = new Map();
  const kyberMap = new Map();
  const lastResort = new Set();
  class Sessions extends S.SessionStore {
    async saveSession(a, r) {
      sessionsMap.set(key(a), r.serialize());
    }
    async getSession(a) {
      const b = sessionsMap.get(key(a));
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
      const old = identitiesMap.get(key(a));
      identitiesMap.set(key(a), k.serialize());
      return old && !eq(old, k.serialize())
        ? S.IdentityChange.ReplacedExisting
        : S.IdentityChange.NewOrUnchanged;
    }
    async isTrustedIdentity(a, k) {
      const old = identitiesMap.get(key(a));
      return !old || eq(old, k.serialize());
    }
    async getIdentity(a) {
      const b = identitiesMap.get(key(a));
      return b ? S.PublicKey.deserialize(b) : null;
    }
  }
  class PreKeys extends S.PreKeyStore {
    async savePreKey(id, r) {
      preKeysMap.set(id, r);
    }
    async getPreKey(id) {
      const r = preKeysMap.get(id);
      if (!r) throw new Error(`no prekey ${id}`);
      return r;
    }
    async removePreKey(id) {
      preKeysMap.delete(id);
    }
  }
  class Signed extends S.SignedPreKeyStore {
    async saveSignedPreKey(id, r) {
      signedMap.set(id, r);
    }
    async getSignedPreKey(id) {
      const r = signedMap.get(id);
      if (!r) throw new Error(`no signed prekey ${id}`);
      return r;
    }
  }
  class Kyber extends S.KyberPreKeyStore {
    async saveKyberPreKey(id, r) {
      kyberMap.set(id, r);
    }
    async getKyberPreKey(id) {
      const r = kyberMap.get(id);
      if (!r) throw new Error(`no kyber prekey ${id}`);
      return r;
    }
    async markKyberPreKeyUsed(id) {
      if (!lastResort.has(id)) kyberMap.delete(id);
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

// ——— Maya ———

async function register() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const { nonce } = await call('/auth/challenge', { purpose: 'register' });
  return call('/auth/register', {
    inviteCode: code,
    username: `maya${randomInt(1e5)}`,
    displayName: 'Maya Chen',
    recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
    device: { name: 'libsignal-node peer', platform: 'ios', signingPublicKey: pub },
    nonce,
    signature: sign(
      null,
      Buffer.from(`koode-auth-v1\nregister\n${nonce}\n${pub}`),
      privateKey,
    ).toString('base64url'),
  });
}

function jpegSize(buf) {
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

/** libsignal's attachment format (Aes256GcmEncryptedData): nonce ‖ ciphertext ‖ tag. */
function sealFile(plain) {
  const fileKey = randomBytes(32);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fileKey, nonce);
  const sealed = Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
  return {
    sealed,
    key: b64(fileKey),
    digest: createHash('sha256').update(sealed).digest('base64'),
  };
}
function openFile(sealed, secret) {
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

async function main() {
  const [, appUser, appId] = await waitForLog(/\[tour-auth\] registered @(\S+) id=(\S+)/);
  await waitForLog(/\[tour-e2ee\] ready/);
  log(`app is @${appUser} (${appId})`);

  const maya = await register();
  const token = maya.accessToken;
  const identity = S.IdentityKeyPair.generate();
  const registrationId = 1 + randomInt(16000);
  const st = stores(identity, registrationId);
  const now = Date.now();

  // Real keys: signed EC prekey, last-resort Kyber, one-time EC and Kyber prekeys.
  const spk = S.PrivateKey.generate();
  await st.signed.saveSignedPreKey(
    1,
    S.SignedPreKeyRecord.new(
      1,
      now,
      spk.getPublicKey(),
      spk,
      identity.privateKey.sign(spk.getPublicKey().serialize()),
    ),
  );
  const kemLast = S.KEMKeyPair.generate();
  await st.kyber.saveKyberPreKey(
    1000,
    S.KyberPreKeyRecord.new(
      1000,
      now,
      kemLast,
      identity.privateKey.sign(kemLast.getPublicKey().serialize()),
    ),
  );
  st.lastResort.add(1000);
  const preKeys = [];
  const kyberPreKeys = [];
  for (let id = 1; id <= 20; id++) {
    const k = S.PrivateKey.generate();
    await st.preKeys.savePreKey(id, S.PreKeyRecord.new(id, k.getPublicKey(), k));
    preKeys.push({ keyId: id, publicKey: b64(k.getPublicKey().serialize()) });
    const kem = S.KEMKeyPair.generate();
    const sig = identity.privateKey.sign(kem.getPublicKey().serialize());
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
        signature: b64(identity.privateKey.sign(spk.getPublicKey().serialize())),
      },
      kyberPreKey: {
        keyId: 1000,
        publicKey: b64(kemLast.getPublicKey().serialize()),
        signature: b64(identity.privateKey.sign(kemLast.getPublicKey().serialize())),
      },
      preKeys,
      kyberPreKeys,
    },
    token,
    'PUT',
  );
  const myDevice = (await call('/keys/status', null, token)).deviceId;
  const local = S.ProtocolAddress.new(maya.user.id, myDevice);
  log(`Maya is ${maya.user.id}.${myDevice}; keys published`);

  async function encryptFor(userIds, plain) {
    const { devices } = await call(`/keys/devices?userIds=${userIds.join(',')}`, null, token);
    const out = [];
    for (const d of devices) {
      if (d.userId === maya.user.id && d.deviceId === myDevice) continue;
      const addr = S.ProtocolAddress.new(d.userId, d.deviceId);
      if (!(await st.sessions.getSession(addr))) {
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
        await S.processPreKeyBundle(bundle, addr, local, st.sessions, st.identities);
      }
      const ct = await S.signalEncrypt(
        new Uint8Array(Buffer.from(plain, 'utf8')),
        addr,
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
    const addr = S.ProtocolAddress.new(senderId, senderDevice);
    const data = B(env.body);
    const plain =
      env.type === 3
        ? await S.signalDecryptPreKey(
            S.PreKeySignalMessage.deserialize(data),
            addr,
            local,
            st.sessions,
            st.identities,
            st.preKeys,
            st.signed,
            st.kyber,
          )
        : await S.signalDecrypt(
            S.SignalMessage.deserialize(data),
            addr,
            local,
            st.sessions,
            st.identities,
          );
    return JSON.parse(Buffer.from(plain).toString('utf8'));
  }

  const conversation = await call('/conversations', { kind: 'direct', userId: appId }, token);
  const conversationId = conversation.id;
  const members = [maya.user.id, appId];
  const send = async (kind, payload, extra = {}) =>
    call(
      `/conversations/${conversationId}/messages`,
      {
        id: payload.id,
        kind,
        envelopes: await encryptFor(members, JSON.stringify(payload)),
        ...extra,
      },
      token,
    );

  // 1. Maya → app: text and photo.
  const hello = {
    v: 1,
    t: 'text',
    id: randomUUID(),
    conversationId,
    body: 'Hello from Signal’s Node library 🔐',
    replyToId: null,
  };
  await send('text', hello);
  const photo = readFileSync(join(mediaDir, 'photo.jpg'));
  const dims = jpegSize(photo);
  const sealedPhoto = sealFile(photo);
  const meta = await call(
    `/conversations/${conversationId}/attachments`,
    { sizeBytes: sealedPhoto.sealed.length },
    token,
  );
  const put = await fetch(`${base}/attachments/${meta.id}/content`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(sealedPhoto.sealed.length),
    },
    body: sealedPhoto.sealed,
  });
  if (!put.ok) throw new Error(`upload ${put.status}`);
  const photoMsg = {
    v: 1,
    t: 'attachment',
    id: randomUUID(),
    conversationId,
    body: 'From Node',
    replyToId: null,
    attachment: {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: photo.length,
      name: null,
      width: dims?.width ?? 1,
      height: dims?.height ?? 1,
      durationMs: null,
      waveform: null,
      preview: null,
      content: { key: sealedPhoto.key, digest: sealedPhoto.digest },
      thumbnail: null,
    },
  };
  await send('attachment', photoMsg, { attachmentId: meta.id });
  // What the server stored is ciphertext only.
  const stored = Buffer.from(
    await (
      await fetch(`${base}/attachments/${meta.id}/content`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).arrayBuffer(),
  );
  check(
    'server holds only ciphertext for the photo',
    !stored.includes(photo.subarray(0, 64)) && stored.length === photo.length + 28,
  );
  log('sent text and photo; waiting for the app');

  const received = await tourJson('received');
  check(
    'app decrypted Maya’s text (Node → Swift)',
    received.texts?.includes(hello.body),
    received.texts,
  );
  check(
    'app had nothing it couldn’t decrypt',
    received.undecryptable?.length === 0,
    received.undecryptable,
  );
  check(
    'app decrypted the photo (digest checked, exact size)',
    received.photo?.size === photo.length && received.photo?.width === dims?.width,
    received.photo,
  );

  // 2. App → Maya: text, photo and a reaction, decrypted here.
  const seen = new Map();
  await waitFor(async () => {
    const page = await call(`/conversations/${conversationId}/messages?limit=100`, null, token);
    for (const m of page.messages) {
      if (m.senderId !== appId || seen.has(m.id) || m.envelopes.length === 0) continue;
      const env = m.envelopes.find((e) => e.deviceId === myDevice);
      try {
        seen.set(m.id, { m, p: await decrypt(m.senderId, m.senderDevice, env) });
      } catch (e) {
        seen.set(m.id, { m, error: String(e) });
      }
    }
    const kinds = [...seen.values()].map((x) => x.m.kind);
    return kinds.includes('text') && kinds.includes('attachment') && kinds.includes('reaction');
  }, 'the app’s text, photo and reaction');
  const errors = [...seen.values()].filter((x) => x.error);
  check(
    'decrypted everything the app sent (Swift → Node)',
    errors.length === 0,
    errors.map((x) => x.error),
  );
  const text = [...seen.values()].find((x) => x.m.kind === 'text');
  check(
    'app’s text',
    text?.p?.body === 'Hi Maya 👋 sent from the app over libsignal' &&
      text.p.id === text.m.id &&
      text.p.conversationId === conversationId,
    text?.p?.body,
  );
  const file = [...seen.values()].find((x) => x.m.kind === 'attachment');
  const ciphertext = Buffer.from(
    await (
      await fetch(`${base}/attachments/${file.m.attachment.id}/content`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).arrayBuffer(),
  );
  let plainPhoto = null;
  try {
    plainPhoto = openFile(ciphertext, file.p.attachment.content);
  } catch (e) {
    log('photo decrypt failed', String(e));
  }
  check(
    'app’s photo decrypts here, digest and size match',
    plainPhoto &&
      plainPhoto.length === file.p.attachment.sizeBytes &&
      plainPhoto[0] === 0xff &&
      plainPhoto[1] === 0xd8,
    { kind: file.p.attachment.kind, size: plainPhoto?.length, w: file.p.attachment.width },
  );
  check(
    'server never saw the photo’s type or size',
    file.m.attachment.kind === 'encrypted' &&
      file.m.attachment.mimeType === 'application/octet-stream' &&
      file.m.attachment.width === null,
  );
  const reaction = [...seen.values()].find((x) => x.m.kind === 'reaction');
  check(
    'app’s reaction (encrypted, bound to its target)',
    reaction?.p?.emoji === '👍' &&
      reaction.p.targetId === hello.id &&
      reaction.m.targetId === hello.id,
    reaction?.p,
  );

  await send(
    'reaction',
    { v: 1, t: 'reaction', id: randomUUID(), conversationId, targetId: text.m.id, emoji: '❤️' },
    { targetId: text.m.id },
  );

  // 3. Safety numbers, computed independently.
  const { devices: appDevices } = await call(`/keys/devices?userIds=${appId}`, null, token);
  const ours = S.Fingerprint.new(
    5200,
    2,
    new Uint8Array(Buffer.from(maya.user.id)),
    identity.publicKey,
    new Uint8Array(Buffer.from(appId)),
    S.PublicKey.deserialize(B(appDevices[0].identityKey)),
  )
    .displayableFingerprint()
    .toString();
  const theirs = await tourJson('safety');
  check('safety numbers match on both sides', theirs.length === 1 && theirs[0] === ours, {
    app: theirs[0],
    node: ours,
  });
  const mine = await tourJson('mine');
  check(
    'app shows Maya’s ❤️ on its message',
    mine.some(([label, , emojis]) => label?.startsWith('Hi Maya') && emojis.includes('❤️')),
    mine,
  );

  // 4. The app calls; Maya answers with the decrypted media key.
  const ringing = await waitFor(
    async () =>
      (await call('/calls', null, token)).calls.find(
        (c) => c.state === 'ringing' && c.callerId === appId,
      ),
    'the app’s call',
  );
  const answered = await call(`/calls/${ringing.id}/accept`, {}, token);
  const callKey = await decrypt(appId, answered.key.senderDevice, answered.key.envelope);
  check(
    'call key decrypts and names this call',
    callKey.t === 'call' && callKey.callId === ringing.id && B(callKey.key).length === 32,
  );

  // Per-room frame decryption states (rtc-node keeps these internal).
  const states = new Map();
  const watchStates = () =>
    globalThis._ffiClientInstance.on('ffi_event', (ev) => {
      const roomEvent = ev.message?.case === 'roomEvent' ? ev.message.value : null;
      const inner = roomEvent?.message;
      if (inner?.case !== 'e2eeStateChanged') return;
      const k = `${roomEvent.roomHandle}:${inner.value.participantIdentity}`;
      states.set(k, [...(states.get(k) ?? []), EncryptionState[inner.value.state]]);
    });

  /** Decoded audio energy from `who`'s track (frames that fail to decrypt are dropped). */
  async function listen(room, label, who) {
    let frames = 0;
    let energy = 0;
    room.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO || participant.identity !== who) return;
      for await (const frame of new AudioStream(track)) {
        frames++;
        for (const s of frame.data) energy += Math.abs(s);
        if (frames > 600) break;
      }
    });
    return () => ({ label, frames, energy });
  }
  const joinAs = async (identity, sharedKey, listenTo) => {
    const t = new AccessToken(devVars.LIVEKIT_API_KEY, devVars.LIVEKIT_API_SECRET, { identity });
    t.addGrant({ room: ringing.id, roomJoin: true, canPublish: false, canSubscribe: true });
    const r = new Room();
    const heard = await listen(r, identity, listenTo);
    await r.connect(answered.media.url, await t.toJwt(), {
      autoSubscribe: true,
      dynacast: false,
      encryption: { keyProviderOptions: { sharedKey } },
    });
    return { room: r, heard };
  };

  const room = new Room();
  const appAudio = await listen(room, 'maya←app', appId);
  await room.connect(answered.media.url, answered.media.token, {
    autoSubscribe: true,
    dynacast: false,
    encryption: { keyProviderOptions: { sharedKey: B(callKey.key) } },
  });
  watchStates();
  // Maya speaks (a tone): the app has encrypted media to decrypt.
  const source = new AudioSource(48000, 1);
  await room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('mic', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  let t = 0;
  const tone = setInterval(() => {
    const data = new Int16Array(480);
    for (let i = 0; i < 480; i++, t++)
      data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * t) / 48000));
    void source.captureFrame(new AudioFrame(data, 48000, 1, 480)).catch(() => {});
  }, 10);

  // Two more listeners to Maya's tone: one with the call key, one with a wrong key.
  const ann = await joinAs('ann', B(callKey.key), maya.user.id);
  const eve = await joinAs('eve', randomBytes(32), maya.user.id);

  const appCall = await tourJson('call');
  await sleep(4000);
  const a = ann.heard();
  const e = eve.heard();
  const fromApp = appAudio();
  log('audio', { ann: a, eve: e, fromApp, app: appCall, states: Object.fromEntries(states) });
  check(
    'app decrypts Maya’s encrypted audio (Node → RN frame encryption)',
    appCall.audio?.energy > 0,
    appCall.audio,
  );
  check('a listener with the call key hears it (control)', a.energy > 0, a);
  check('a listener with the wrong key hears nothing', e.energy === 0, e);
  check('app reports the call as end-to-end encrypted', appCall.encrypted === true, appCall);
  log(
    `(app → Maya audio energy ${fromApp.energy}: the Simulator microphone is ${fromApp.energy > 0 ? 'live' : 'silent, so that direction can’t be judged here'})`,
  );

  const svc = new RoomServiceClient(
    devVars.LIVEKIT_URL.replace(/^ws/, 'http'),
    devVars.LIVEKIT_API_KEY,
    devVars.LIVEKIT_API_SECRET,
  );
  const participants = await svc.listParticipants(ringing.id);
  const tracks = participants.flatMap((p) =>
    p.identity === 'eve'
      ? []
      : p.tracks.map((tr) => ({
          who: p.identity === appId ? 'app' : 'maya',
          type: tr.type,
          encryption: tr.encryption,
        })),
  );
  check(
    'every published track is GCM-encrypted (seen by the SFU)',
    tracks.length >= 2 && tracks.every((tr) => tr.encryption === 1),
    tracks,
  );

  clearInterval(tone);
  await ann.room.disconnect();
  await eve.room.disconnect();
  await waitForLog(/\[tour-e2ee\] done/, 60_000).catch(() => {});
  await room.disconnect();

  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[peer] ERROR', e);
  process.exit(2);
});
