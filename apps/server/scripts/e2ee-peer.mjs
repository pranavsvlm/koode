#!/usr/bin/env node
/**
 * End-to-end encryption interoperability check, paired with the app's E2EE
 * tour (EXPO_PUBLIC_DEV_TOUR=e2ee). Plays "Maya" with Signal's own Node
 * library, a second implementation alongside the app's Swift one:
 *
 *   node scripts/e2ee-peer.mjs <maya-invite> <metro-log> <media-dir>
 *
 *  1. sends the app an encrypted text and photo; the app reports what it
 *     decrypted;
 *  2. decrypts the app's text, photo (digest checked) and reaction; reacts back;
 *  3. compares safety numbers computed independently on both sides;
 *  4. answers the app's call with the decrypted media key and checks frame
 *     encryption: the app decodes Maya's audio, a listener with the key hears
 *     it, one with a wrong key hears nothing, LiveKit marks every track GCM.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as S from '@signalapp/libsignal-client';
import { RoomServiceClient } from 'livekit-server-sdk';
import {
  base,
  call,
  checks,
  createPeer,
  devVars,
  joinAs,
  jpegSize,
  log,
  metro,
  sleep,
  waitFor,
} from './lib/peer.mjs';

const [invite, metroLog, mediaDir] = process.argv.slice(2);
const { waitForLog, tourJson, appUser } = metro(metroLog);
const { check, finish } = checks();
const tour = (label, timeoutMs) => tourJson('e2ee', label, timeoutMs);

async function main() {
  const app = await appUser();
  await waitForLog(/\[tour-e2ee\] ready/);
  const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
  const chat = await maya.chatWith(app.id);

  // 1. Maya → app: text and photo.
  const { payload: hello } = await maya.sendText(chat, 'Hello from Signal’s Node library 🔐');
  const photo = readFileSync(join(mediaDir, 'photo.jpg'));
  const dims = jpegSize(photo);
  const { message: photoMsg } = await maya.sendFile(chat, photo, {
    kind: 'image',
    mimeType: 'image/jpeg',
    width: dims?.width,
    height: dims?.height,
    caption: 'From Node',
  });
  const stored = Buffer.from(
    await (
      await fetch(`${base}/attachments/${photoMsg.attachment.id}/content`, {
        headers: { authorization: `Bearer ${maya.token}` },
      })
    ).arrayBuffer(),
  );
  check(
    'server holds only ciphertext for the photo',
    !stored.includes(photo.subarray(0, 64)) && stored.length === photo.length + 28,
  );

  const received = await tour('received');
  check(
    'app decrypted Maya’s text (Node libsignal → app)',
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

  // 2. App → Maya: text, photo and a reaction.
  const fromApp = await waitFor(async () => {
    const list = (await maya.history(chat)).filter((x) => x.m.senderId === app.id);
    const kinds = list.map((x) => x.m.kind);
    return ['text', 'attachment', 'reaction'].every((k) => kinds.includes(k)) && list;
  }, 'the app’s text, photo and reaction');
  const errors = fromApp.filter((x) => x.error);
  check(
    'decrypted everything the app sent (app → Node libsignal)',
    errors.length === 0,
    errors.map((x) => x.error),
  );
  const text = fromApp.find((x) => x.m.kind === 'text');
  check(
    'app’s text',
    text?.p?.body === 'Hi Maya 👋 sent from the app over libsignal' &&
      text.p.id === text.m.id &&
      text.p.conversationId === chat,
    text?.p?.body,
  );
  const file = fromApp.find((x) => x.m.kind === 'attachment');
  let plain = null;
  try {
    plain = (await maya.download(file.m.attachment.id, file.p.attachment.content)).plain;
  } catch (e) {
    log('photo decrypt failed', String(e));
  }
  check(
    'app’s photo decrypts here, digest and size match',
    plain && plain.length === file.p.attachment.sizeBytes && plain[0] === 0xff && plain[1] === 0xd8,
    { kind: file.p.attachment.kind, size: plain?.length, w: file.p.attachment.width },
  );
  check(
    'server never saw the photo’s type or size',
    file.m.attachment.kind === 'encrypted' &&
      file.m.attachment.mimeType === 'application/octet-stream' &&
      file.m.attachment.width === null,
  );
  const reaction = fromApp.find((x) => x.m.kind === 'reaction');
  check(
    'app’s reaction (encrypted, bound to its target)',
    reaction?.p?.emoji === '👍' &&
      reaction.p.targetId === hello.id &&
      reaction.m.targetId === hello.id,
    reaction?.p,
  );
  await maya.react(chat, text.m.id, '❤️');

  // 3. Safety numbers, computed independently.
  const { devices } = await call(`/keys/devices?userIds=${app.id}`, null, maya.token);
  const ours = S.Fingerprint.new(
    5200,
    2,
    new Uint8Array(Buffer.from(maya.user.id)),
    maya.identityKey,
    new Uint8Array(Buffer.from(app.id)),
    S.PublicKey.deserialize(new Uint8Array(Buffer.from(devices[0].identityKey, 'base64'))),
  )
    .displayableFingerprint()
    .toString();
  const theirs = await tour('safety');
  check('safety numbers match on both sides', theirs.length === 1 && theirs[0] === ours, {
    app: theirs[0],
    node: ours,
  });
  const mine = await tour('mine');
  check(
    'app shows Maya’s ❤️ on its message',
    mine.some(([label, , emojis]) => label?.startsWith('Hi Maya') && emojis.includes('❤️')),
    mine,
  );

  // 4. The app calls; Maya answers with the decrypted media key.
  const ringing = await waitFor(
    async () =>
      (await call('/calls', null, maya.token)).calls.find(
        (c) => c.state === 'ringing' && c.callerId === app.id,
      ),
    'the app’s call',
  );
  const answered = await maya.acceptCall(ringing.id);
  check('call key decrypts and names this call', answered.mediaKey.length === 44);
  const media = await maya.joinMedia(answered, { listenTo: app.id });
  const key = new Uint8Array(Buffer.from(answered.mediaKey, 'base64'));
  const url = answered.media.url;
  const ann = await joinAs('ann', ringing.id, url, key, maya.user.id);
  const eve = await joinAs('eve', ringing.id, url, randomBytes(32), maya.user.id);

  const appCall = await tour('call');
  await sleep(4000);
  const a = ann.heard();
  const e = eve.heard();
  const fromAppAudio = media.heard();
  check(
    'app decrypts Maya’s encrypted audio (Node → RN frame encryption)',
    appCall.audio?.energy > 0,
    appCall.audio,
  );
  check('a listener with the call key hears it (control)', a.energy > 0, a);
  check('a listener with the wrong key hears nothing', e.energy === 0, e);
  check('app reports the call as end-to-end encrypted', appCall.encrypted === true, appCall);
  log(
    `(app → Maya audio energy ${fromAppAudio.energy}: the Simulator microphone is ${fromAppAudio.energy > 0 ? 'live' : 'silent, so that direction can’t be judged here'})`,
  );

  const svc = new RoomServiceClient(
    devVars.LIVEKIT_URL.replace(/^ws/, 'http'),
    devVars.LIVEKIT_API_KEY,
    devVars.LIVEKIT_API_SECRET,
  );
  const tracks = (await svc.listParticipants(ringing.id)).flatMap((p) =>
    ['ann', 'eve'].includes(p.identity)
      ? []
      : p.tracks.map((t) => ({
          who: p.identity === app.id ? 'app' : 'maya',
          encryption: t.encryption,
        })),
  );
  check(
    'every published track is GCM-encrypted (seen by the SFU)',
    tracks.length >= 2 && tracks.every((t) => t.encryption === 1),
    tracks,
  );

  await ann.leave();
  await eve.leave();
  await waitForLog(/\[tour-e2ee\] done/, 60_000).catch(() => {});
  await media.leave();
  finish();
}

main().catch((e) => {
  console.error('[peer] ERROR', e);
  process.exit(2);
});
