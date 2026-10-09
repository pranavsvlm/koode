#!/usr/bin/env node
/**
 * Development peer for end-to-end calling checks: a second account ("Maya")
 * driven from Node against the local server, with the LiveKit CLI (`lk`) as
 * its media client. Works with the app's calling tour (EXPO_PUBLIC_DEV_TOUR=calls)
 * and a local `livekit-server --dev`.
 *
 *   node scripts/call-peer.mjs <maya-invite-code> <metro-log-path>
 *
 * Starts a chat with the app's account, video-calls it, joins the room once the
 * app accepts (publishing the CLI's demo video), hangs up, then declines the
 * app's call back.
 */
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [code, metroLog] = process.argv.slice(2);
const base = 'http://localhost:8787/v1';
const log = (...a) => console.log('[peer]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logStart = readFileSync(metroLog, 'utf8').length;

async function call(path, body, token) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
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

async function waitFor(check, what, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitForLog = (pattern) =>
  waitFor(() => readFileSync(metroLog, 'utf8').slice(logStart).match(pattern), pattern);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' }).x;
const { nonce } = await call('/auth/challenge', { purpose: 'register' });
const maya = await call('/auth/register', {
  inviteCode: code,
  username: `maya${Math.floor(Math.random() * 1e5)}`,
  displayName: 'Maya Chen',
  recoveryKey: 'P4Y98RJRK0XWTX0YKB7TV8DC',
  device: { name: 'Peer script', platform: 'ios', signingPublicKey: pub },
  nonce,
  signature: sign(
    null,
    Buffer.from(`koode-auth-v1\nregister\n${nonce}\n${pub}`),
    privateKey,
  ).toString('base64url'),
});
const token = maya.accessToken;
log(`registered @${maya.user.username} (${maya.user.id})`);

const [, appUserId] = await waitForLog(/\[tour-auth\] registered @\S+ id=(usr_[\w-]+)/);
log(`app user is ${appUserId}`);
const conversation = await call('/conversations', { kind: 'direct', userId: appUserId }, token);
await call(
  `/conversations/${conversation.id}/messages`,
  { id: randomUUID(), body: 'Calling you now 📞' },
  token,
);

// 1. Video-call the app and join the media room once it accepts.
await waitForLog(/\[tour-call\] ready/);
const { call: outgoing, media } = await call('/calls', { userId: appUserId, kind: 'video' }, token);
log(`calling: ${outgoing.id} (${outgoing.state}); token issued for ${media.url}`);
const active = await waitFor(async () => {
  const c = await call(`/calls/${outgoing.id}`, undefined, token);
  return c.state === 'active' && c;
}, 'the app to accept');
log(`app accepted at ${new Date(active.answeredAt).toISOString()}`);

const lk = spawn(
  'lk',
  ['room', 'join', '--dev', '--identity', maya.user.id, '--publish-demo', outgoing.id],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
lk.stderr.on('data', (d) => /error/i.test(d) && log('lk:', String(d).trim()));
await waitForLog(/\[tour-call\] connected /);
await sleep(3000); // give both sides time to publish
const participants = execFileSync('lk', ['room', 'participants', 'list', '--dev', outgoing.id], {
  encoding: 'utf8',
});
log(`room participants:\n${participants.trim()}`);

// 2. Hang up from this side.
await waitForLog(/\[tour-call\] hangup-please/);
const ended = await call(`/calls/${outgoing.id}/end`, {}, token);
lk.kill();
log(`hung up: ${ended.state}, ${Math.round((ended.endedAt - ended.answeredAt) / 1000)}s`);

// 3. Decline the app's call back.
const incoming = await waitFor(async () => {
  const { calls } = await call('/calls', undefined, token);
  return calls.find((c) => c.callerId === appUserId && c.state === 'ringing');
}, 'a call from the app');
log(`app is calling: ${incoming.id} (${incoming.kind})`);
await sleep(9000); // let it ring on screen
const declined = await call(`/calls/${incoming.id}/decline`, {}, token);
log(`declined: ${declined.state}`);

const { calls } = await call('/calls', undefined, token);
log(`history: ${JSON.stringify(calls.map((c) => [c.kind, c.state]))}`);
