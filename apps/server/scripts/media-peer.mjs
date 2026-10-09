#!/usr/bin/env node
/**
 * Development peer for end-to-end media and group checks, paired with the
 * app's media tour (EXPO_PUBLIC_DEV_TOUR=media). Plays "Maya" and "Sam".
 *
 *   node scripts/media-peer.mjs <maya-invite> <sam-invite> <metro-log> <media-dir>
 *
 * <media-dir> holds photo.jpg, clip.mp4, poster.jpg, notes.pdf and voice.m4a.
 * Maya sends one of each; then the files the app sends are downloaded and
 * checked (EXIF removed, poster present, documents served as downloads), and
 * reactions, deletion and group changes are verified from the server's side.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [mayaCode, samCode, metroLog, mediaDir] = process.argv.slice(2);
const base = 'http://localhost:8787/v1';
const log = (...a) => console.log('[peer]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logStart = readFileSync(metroLog, 'utf8').length;

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
  if (!res.ok)
    throw Object.assign(new Error(`${path} → ${res.status} ${JSON.stringify(json)}`), {
      status: res.status,
    });
  return json;
}
const raw = (path, token, init = {}) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

async function waitFor(check, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitForLog = (pattern) =>
  waitFor(() => readFileSync(metroLog, 'utf8').slice(logStart).match(pattern), pattern);

async function register(code, username, displayName) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const { nonce } = await call('/auth/challenge', { purpose: 'register' });
  return call('/auth/register', {
    inviteCode: code,
    username: `${username}${Math.floor(Math.random() * 1e5)}`,
    displayName,
    recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
    device: { name: 'Peer script', platform: 'ios', signingPublicKey: pub },
    nonce,
    signature: sign(
      null,
      Buffer.from(`koode-auth-v1\nregister\n${nonce}\n${pub}`),
      privateKey,
    ).toString('base64url'),
  });
}

async function sendFile(token, conversationId, file, request, poster) {
  const data = readFileSync(join(mediaDir, file));
  const meta = await call(
    `/conversations/${conversationId}/attachments`,
    { ...request, sizeBytes: data.length },
    token,
  );
  const put = async (part, body, type) => {
    const res = await raw(`/attachments/${meta.id}/${part}`, token, {
      method: 'PUT',
      headers: { 'content-type': type, 'content-length': String(body.length) },
      body,
    });
    if (!res.ok) throw new Error(`upload ${part} → ${res.status}`);
  };
  await put('content', data, request.mimeType);
  if (poster) await put('thumbnail', readFileSync(join(mediaDir, poster)), 'image/jpeg');
  return call(
    `/conversations/${conversationId}/messages`,
    { id: randomUUID(), attachmentId: meta.id },
    token,
  );
}

const maya = await register(mayaCode, 'maya', 'Maya Chen');
const sam = await register(samCode, 'sam', 'Sam Lee');
log(`registered @${maya.user.username} and @${sam.user.username}`);
const [, appUserId] = await waitForLog(/\[tour-auth\] registered @\S+ id=(usr_[\w-]+)/);
const chat = await call('/conversations', { kind: 'direct', userId: appUserId }, maya.accessToken);
// Sam says hello too, so the app knows which Sam to add to a group later.
await call('/conversations', { kind: 'direct', userId: appUserId }, sam.accessToken);

// 1. Maya sends a photo, a video (with poster), a document and a voice message.
await waitForLog(/\[tour-media\] ready/);
await sendFile(maya.accessToken, chat.id, 'photo.jpg', {
  kind: 'image',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 900,
});
await sendFile(
  maya.accessToken,
  chat.id,
  'clip.mp4',
  { kind: 'video', mimeType: 'video/mp4', width: 640, height: 360, durationMs: 3000 },
  'poster.jpg',
);
await sendFile(maya.accessToken, chat.id, 'notes.pdf', {
  kind: 'document',
  mimeType: 'application/pdf',
  name: 'Agenda.pdf',
});
await sendFile(maya.accessToken, chat.id, 'voice.m4a', {
  kind: 'voice',
  mimeType: 'audio/mp4',
  durationMs: 2000,
  waveform: [0.2, 0.6, 1, 0.5, 0.3],
});
log('files-sent');

// 2. Check what the app sent.
const mine = async () =>
  (await call(`/conversations/${chat.id}/messages`, undefined, maya.accessToken)).messages.filter(
    (m) => m.senderId === appUserId && m.attachment,
  );
const fromApp = await waitFor(async () => {
  const list = await mine();
  return list.length >= 4 && list;
}, 'four files from the app');
const byKind = Object.fromEntries(fromApp.map((m) => [m.attachment.kind, m]));
const content = async (m) => {
  const res = await raw(`/attachments/${m.attachment.id}/content`, maya.accessToken);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};
{
  const { bytes } = await content(byKind.image);
  log('photo', {
    jpeg: bytes[0] === 0xff && bytes[1] === 0xd8,
    // The test photo carried a GPS position and camera make ("TestCam").
    gpsRemoved: !bytes.includes(Buffer.from([0x88, 0x25])),
    makeRemoved: !bytes.includes(Buffer.from('TestCam')),
    size: [byKind.image.attachment.width, byKind.image.attachment.height],
    preview: !!byKind.image.attachment.preview,
  });
}
{
  const { res, bytes } = await content(byKind.video);
  const poster = await raw(
    `/attachments/${byKind.video.attachment.id}/thumbnail`,
    maya.accessToken,
  );
  log('video', {
    bytesMatch: bytes.length === byKind.video.attachment.sizeBytes,
    type: res.headers.get('content-type'),
    poster: poster.status,
    durationMs: byKind.video.attachment.durationMs,
  });
}
{
  const { res } = await content(byKind.document);
  log('document', {
    type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
  });
}
{
  const { res, bytes } = await content(byKind.voice);
  log('voice', {
    type: res.headers.get('content-type'),
    bytes: bytes.length,
    waveform: byKind.voice.attachment.waveform,
  });
}
await call(
  `/conversations/${chat.id}/messages/${byKind.image.id}/reaction`,
  { emoji: '❤️' },
  maya.accessToken,
  'PUT',
);
log('reacted ❤️ to the app’s photo');

// 3. The app's reaction and deletion.
await waitForLog(/\[tour-media\] reacted/);
const all = (await call(`/conversations/${chat.id}/messages`, undefined, maya.accessToken))
  .messages;
const mayaPhoto = all.find((m) => m.senderId === maya.user.id && m.attachment?.kind === 'image');
log('reactions on Maya’s photo', mayaPhoto.reactions);
await waitForLog(/\[tour-media\] deleted/);
const doc = (
  await call(`/conversations/${chat.id}/messages`, undefined, maya.accessToken)
).messages.find((m) => m.id === byKind.document.id);
const gone = await raw(`/attachments/${byKind.document.attachment.id}/content`, maya.accessToken);
log('deleted document', {
  deletedAt: !!doc.deletedAt,
  body: doc.body,
  attachment: doc.attachment,
  file: gone.status,
});

// A voice message recorded in the app (Simulator microphone).
await waitForLog(/\[tour-media\] recorded/);
const recorded = await waitFor(
  async () => {
    const voices = (await mine()).filter((m) => m.attachment?.kind === 'voice');
    return voices.length >= 2 && voices.at(-1);
  },
  'the recorded voice message',
  30_000,
);
{
  const { res, bytes } = await content(recorded);
  log('recorded voice', {
    type: res.headers.get('content-type'),
    bytes: bytes.length,
    durationMs: recorded.attachment.durationMs,
    waveformPoints: recorded.attachment.waveform.length,
    m4a: bytes.subarray(4, 8).toString() === 'ftyp',
  });
}

// 4. Group: Maya was removed, Sam was added and made admin.
const [, groupId] = await waitForLog(/\[tour-media\] group-done "([\w-]+)"/);
const mayaAccess = await raw(`/conversations/${groupId}/messages`, maya.accessToken);
const group = await call(`/conversations/${groupId}`, undefined, sam.accessToken);
const events = (
  await call(`/conversations/${groupId}/messages`, undefined, sam.accessToken)
).messages
  .filter((m) => m.kind === 'system')
  .map((m) => m.system.action);
log('group', {
  mayaAccess: mayaAccess.status,
  title: group.title,
  samRole: group.members.find((m) => m.userId === sam.user.id)?.role,
  events,
});
log('done');
