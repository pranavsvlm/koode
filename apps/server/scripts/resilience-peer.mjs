#!/usr/bin/env node
/**
 * Resilience check, paired with the app's resilience tour
 * (EXPO_PUBLIC_DEV_TOUR=resilience) and scratchpad runner that stops and
 * restarts the server and backgrounds the app. Plays "Maya":
 *
 *   node scripts/resilience-peer.mjs <maya-invite> <metro-log> <media-dir>
 *
 * Checks that what the app queued offline arrives (decrypted) once the server
 * is back, that it catches up after the background, that a denied permission
 * gives a clear error, and that after sign-out and account recovery the new
 * device gets new messages while old ones stay unreadable to it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, checks, createPeer, metro, waitFor } from './lib/peer.mjs';

const [invite, metroLog, mediaDir] = process.argv.slice(2);
const { waitForLog, tourJson, appUser } = metro(metroLog);
const { check, finish } = checks();
const tour = (label, timeoutMs = 300_000) => tourJson('res', label, timeoutMs);

const app = await appUser();
await tour('ready');
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
const chat = await maya.chatWith(app.id);
await maya.sendText(chat, 'one');
await maya.sendFile(chat, readFileSync(join(mediaDir, 'photo.jpg')), {
  kind: 'image',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 900,
});

// 1. Offline outbox (the runner stops the server, then restarts it).
const queued = await tour('queued');
check(
  'while the server is down, both sends wait in the outbox',
  queued.connection !== 'online' &&
    queued.states.length === 2 &&
    queued.states.every((s) => s === 'sending'),
  queued,
);
const delivered = await tour('delivered');
check(
  'once it’s back, they go out by themselves',
  delivered.states.every((s) => s !== 'failed'),
  delivered,
);
const fromApp = await waitFor(async () => {
  const list = (await maya.history(chat)).filter((x) => x.m.senderId === app.id && x.p);
  return list.length >= 2 && list;
}, 'the queued messages');
const text = fromApp.find((x) => x.m.kind === 'text');
const photo = fromApp.find((x) => x.m.kind === 'attachment');
const photoBytes =
  photo && (await maya.download(photo.m.attachment.id, photo.p.attachment.content)).plain;
check(
  'Maya decrypts the queued text and photo',
  text?.p.body === 'queued while offline' &&
    photoBytes?.[0] === 0xff &&
    photoBytes.length === photo.p.attachment.sizeBytes,
  { text: text?.p.body, photo: photoBytes?.length },
);

// 2. Background (the runner sends the app to the home screen for a while).
await waitForLog(/\[tour-res\] background-now/);
// After the app has disconnected to save battery: it must catch up on return.
await waitForLog(/\[messaging\] suspended/, 120_000);
check('the app disconnects after 30 s in the background', true);
await maya.sendText(chat, 'while you were away');
const caughtUp = await tour('caught-up');
check(
  'back in the foreground, the app caught up',
  caughtUp.texts.includes('while you were away'),
  caughtUp,
);

// 3. Photos permission denied by the runner.
const photos = await tour('photos');
check(
  'a denied permission is a clear, friendly error',
  photos.saved === false && photos.friendly,
  photos,
);

// 4. Sign out, recover as a new device.
const signedOut = await tour('signed-out');
check('sign-out erases the chats on the device', signedOut.cachedChats === 0, signedOut);
const recovered = await tour('recovered');
check('recovery signs in as a new device', recovered.device >= 2, recovered);
await maya.sendText(chat, 'hello, new device');
const after = await tour('after-recovery');
check(
  'the new device decrypts new messages; older ones are unavailable to it',
  after.texts.includes('hello, new device') && after.unavailable >= 2,
  after,
);
const fromNew = await waitFor(
  async () =>
    (await maya.history(chat)).find(
      (x) => x.m.senderId === app.id && x.p?.body === 'sent from my new device',
    ),
  'the new device’s message',
  60_000,
);
check(
  'Maya decrypts a message from the new device',
  !!fromNew && fromNew.m.senderDevice === recovered.device,
);
await maya.sendText(chat, 'got it, bye');

// 5. Account deletion.
const deleted = await tour('deleted');
check(
  'the app signs out and keeps nothing',
  deleted.status === 'signedOut' && deleted.cachedChats === 0,
  deleted,
);
const afterDelete = (await maya.history(chat)).filter((x) => x.m.senderId === app.id);
check(
  'everything the account sent is deleted for Maya too',
  afterDelete.length > 0 &&
    afterDelete.every((x) => x.m.deletedAt !== null && x.m.envelopes.length === 0),
  afterDelete.length,
);
const directory = await call('/users', null, maya.token);
check('the account is gone from the directory', !directory.users.some((u) => u.id === app.id));
finish();
