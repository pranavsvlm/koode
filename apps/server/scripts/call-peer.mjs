#!/usr/bin/env node
/**
 * Development peer for end-to-end calling checks, paired with the app's
 * calling tour (EXPO_PUBLIC_DEV_TOUR=calls) and a local `livekit-server --dev`.
 * Plays "Maya":
 *
 *   node scripts/call-peer.mjs <maya-invite-code> <metro-log-path>
 *
 * Video-calls the app with an end-to-end encrypted media key; once the app
 * answers (decrypting the key on the device), joins with frame encryption and
 * a tone the app must decode; hangs up; then declines the app's call back.
 */
import { call, checks, createPeer, log, metro, sleep, waitFor } from './lib/peer.mjs';

const [invite, metroLog] = process.argv.slice(2);
const { waitForLog, tourJson, appUser } = metro(metroLog);
const { check, finish } = checks();

const app = await appUser();
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
const chat = await maya.chatWith(app.id);
await maya.sendText(chat, 'Calling you now 📞');

// 1. Video-call the app; join the media room once it answers.
await waitForLog(/\[tour-call\] ready/);
const outgoing = await maya.startCall(app.id, 'video');
log(`calling ${outgoing.call.id}`);
await waitFor(
  async () => (await call(`/calls/${outgoing.call.id}`, undefined, maya.token)).state === 'active',
  'the app to answer',
);
const media = await maya.joinMedia(outgoing, { listenTo: app.id });

const connected = await tourJson('call', 'connected');
check('app answered and connected', connected.phase === 'connected' && connected.remote, connected);
const appMedia = await tourJson('call', 'media');
check(
  'app decrypted the media key and decodes Maya’s encrypted audio',
  appMedia.audio?.energy > 0,
  appMedia.audio,
);
check('app shows the call as end-to-end encrypted', appMedia.encrypted === true, appMedia);
const muted = await tourJson('call', 'muted');
check('mute works mid-call', muted.mic === false, muted);

// 2. Hang up from this side.
await waitForLog(/\[tour-call\] hangup-please/);
const ended = await call(`/calls/${outgoing.call.id}/end`, {}, maya.token);
await media.leave();
const after = await tourJson('call', 'after-hangup');
check('app saw the call end', after.phase === 'ended' || after.phase === 'idle', after);
log(`hung up after ${Math.round((ended.endedAt - ended.answeredAt) / 1000)} s`);

// 3. Decline the app's call back.
const incoming = await waitFor(async () => {
  const { calls } = await call('/calls', undefined, maya.token);
  return calls.find((c) => c.callerId === app.id && c.state === 'ringing');
}, 'a call from the app');
await sleep(9000); // let it ring on screen
await call(`/calls/${incoming.id}/decline`, {}, maya.token);
const declined = await tourJson('call', 'declined');
check('app showed “declined”', declined.lastEnded === 'declined', declined);

const { calls } = await call('/calls', undefined, maya.token);
check(
  'call history: an answered video call and a declined voice call',
  JSON.stringify(calls.map((c) => [c.kind, c.state])) ===
    JSON.stringify([
      ['voice', 'declined'],
      ['video', 'ended'],
    ]),
  calls.map((c) => [c.kind, c.state]),
);
finish();
