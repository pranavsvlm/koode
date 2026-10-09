#!/usr/bin/env node
/**
 * Development peer for end-to-end push checks: a second account ("Maya")
 * driven from Node, paired with the app's push tour (EXPO_PUBLIC_DEV_TOUR=push),
 * the local Worker and the push relay in simulator mode.
 *
 *   node scripts/push-peer.mjs <maya-invite-code> <metro-log-path> <killed-flag-path>
 *
 * Sends a message while the app is open, a message and a cancelled call while
 * it's in the background, a call the app answers through CallKit, and (once
 * the runner creates <killed-flag-path>) a message while the app is closed.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const [code, metroLog, killedFlag] = process.argv.slice(2);
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

async function waitFor(check, what, timeoutMs = 180_000) {
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
log(`registered @${maya.user.username}`);

const [, appUserId] = await waitForLog(/\[tour-auth\] registered @\S+ id=(usr_[\w-]+)/);
const conversation = await call('/conversations', { kind: 'direct', userId: appUserId }, token);
const send = (body) =>
  call(`/conversations/${conversation.id}/messages`, { id: randomUUID(), body }, token);

// 1. App in the foreground.
await waitForLog(/\[tour-push\] ready/);
await send('Hello while the app is open');
log('sent foreground message');

// 2. App in the background: a message, a call that gives up, and a call
// left ringing for the app to answer from its notification.
await waitForLog(/\[tour-push\] background-now/);
await sleep(2000);
await send('Are you there?');
const { call: missed } = await call('/calls', { userId: appUserId, kind: 'voice' }, token);
await sleep(3000);
log(`cancelled call: ${(await call(`/calls/${missed.id}/end`, {}, token)).state}`);
const { call: ringing } = await call('/calls', { userId: appUserId, kind: 'video' }, token);
await sleep(2000);
log('background-done');
try {
  const active = await waitFor(
    async () => {
      const c = await call(`/calls/${ringing.id}`, undefined, token);
      return c.state === 'active' && c;
    },
    'the app to answer',
    40_000,
  );
  log(`answered from the notification: ${active.state}`);
  await waitForLog(/\[tour-push\] hangup-please/);
} catch (e) {
  log(`NOT answered: ${e.message}`);
}
log(`hung up: ${(await call(`/calls/${ringing.id}/end`, {}, token)).state}`);

// 3. A call reported to CallKit by the native VoIP handler (which the
// Simulator ends at once, so the app should decline it).
await waitForLog(/\[tour-push\] call-me/);
const { call: third } = await call('/calls', { userId: appUserId, kind: 'voice' }, token);
await sleep(4000);
log(`CallKit-ended call: ${(await call(`/calls/${third.id}`, undefined, token)).state}`);
await call(`/calls/${third.id}/end`, {}, token);

// 4. App closed (the runner terminates it and creates the flag file).
await waitFor(() => existsSync(killedFlag), 'the app to be closed', 300_000);
await send('Sent while the app was closed');
log('sent-while-killed');
