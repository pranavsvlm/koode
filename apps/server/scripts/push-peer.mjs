#!/usr/bin/env node
/**
 * Development peer for end-to-end push checks, paired with the app's push tour
 * (EXPO_PUBLIC_DEV_TOUR=push), the local Worker and the push relay in
 * simulator mode. Plays "Maya":
 *
 *   node scripts/push-peer.mjs <maya-invite-code> <metro-log-path> <killed-flag-path>
 *
 * Sends an encrypted message while the app is open, a message and a cancelled
 * call while it's in the background, a call the app answers from its
 * notification (decrypting the media key), a call reported to CallKit, and
 * (once the runner creates <killed-flag-path>) a message while the app is
 * closed. Notifications must never carry message text.
 */
import { existsSync } from 'node:fs';
import { call, checks, createPeer, log, metro, sleep, waitFor } from './lib/peer.mjs';

const [invite, metroLog, killedFlag] = process.argv.slice(2);
const { waitForLog, tourJson, appUser } = metro(metroLog);
const { check, finish } = checks();
const tour = (label, timeoutMs) => tourJson('push', label, timeoutMs);

const app = await appUser();
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
const chat = await maya.chatWith(app.id);
const secrets = ['Hello while the app is open', 'Are you there?', 'Sent while the app was closed'];

// 1. App in the foreground.
await waitForLog(/\[tour-push\] ready/);
await maya.sendText(chat, secrets[0]);

// 2. App in the background: a message, a call that gives up, and a call left
// ringing for the app to answer from its notification.
await waitForLog(/\[tour-push\] background-now/);
await sleep(2000);
await maya.sendText(chat, secrets[1]);
const missed = await maya.startCall(app.id, 'voice');
await sleep(3000);
await call(`/calls/${missed.call.id}/end`, {}, maya.token);
const ringing = await maya.startCall(app.id, 'video');
await sleep(2000);
log('background-done');

const presented = await tour('presented');
check(
  'notifications arrived while in the background',
  presented.some((n) => n.title === 'Maya Chen'),
  presented.map((n) => [n.title, n.body]),
);
check(
  'no notification carries message text',
  !JSON.stringify(presented).match(/Are you there|Hello while/),
);

const answered = await waitFor(
  async () => (await call(`/calls/${ringing.call.id}`, undefined, maya.token)).state === 'active',
  'the app to answer from the notification',
  40_000,
).catch(() => false);
check('app answered the call from its notification', answered);
const afterAnswer = await tour('after-answer');
check(
  'app joined the answered call (media key decrypted)',
  ['connecting', 'connected'].includes(afterAnswer.phase),
  afterAnswer,
);
await waitForLog(/\[tour-push\] hangup-please/);
await call(`/calls/${ringing.call.id}/end`, {}, maya.token);

// 3. A call reported to CallKit by the native VoIP handler (the Simulator ends
// it at once, so the app declines it).
await waitForLog(/\[tour-push\] call-me/);
const third = await maya.startCall(app.id, 'voice');
let state = null;
await waitFor(
  async () =>
    (state = (await call(`/calls/${third.call.id}`, undefined, maya.token)).state) !== 'ringing',
  'the CallKit-ended call to be declined',
  15_000,
).catch(() => {});
check('a CallKit-ended call is declined', state === 'declined', state);
await call(`/calls/${third.call.id}/end`, {}, maya.token);

// 4. App closed (the runner terminates it and creates the flag file).
await waitFor(() => existsSync(killedFlag), 'the app to be closed', 300_000);
await maya.sendText(chat, secrets[2]);
log('sent-while-killed');
finish();
