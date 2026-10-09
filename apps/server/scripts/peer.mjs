#!/usr/bin/env node
/**
 * Development peer for end-to-end messaging checks: a second account ("Maya")
 * driven from Node against the local server. Works with the app's messaging
 * tour (EXPO_PUBLIC_DEV_TOUR=messaging).
 *
 *   node scripts/peer.mjs <maya-invite-code> <metro-log-path>
 *
 * Waits for the app to log its registration, starts a chat with it, waits for
 * the app's message, then marks it read, types over the WebSocket and replies.
 */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [code, metroLog] = process.argv.slice(2);
const base = 'http://localhost:8787/v1';
const log = (...a) => console.log('[peer]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForLog(pattern, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = readFileSync(metroLog, 'utf8').match(pattern);
    if (m) return m;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${pattern}`);
}

const [, appUserId] = await waitForLog(/\[tour-auth\] registered @\S+ id=(usr_[\w-]+)/);
log(`app user is ${appUserId}`);
const conversation = await call('/conversations', { kind: 'direct', userId: appUserId }, token);
await call(
  `/conversations/${conversation.id}/messages`,
  { id: randomUUID(), body: 'Hi from Maya 👋 (sent by the peer script)' },
  token,
);
log(`started ${conversation.id} and sent a message`);

await waitForLog(/\[tour-msg\] sent/);
let appMessage;
for (let i = 0; i < 40 && !appMessage; i++) {
  const page = await call(`/conversations/${conversation.id}/messages`, undefined, token);
  appMessage = page.messages.find((m) => m.senderId === appUserId);
  if (!appMessage) await sleep(250);
}
if (!appMessage) throw new Error('app message never arrived');
log(`received from app: "${appMessage.body}" (seq ${appMessage.seq})`);

await call(`/conversations/${conversation.id}/receipts`, { read: appMessage.seq }, token);
log('marked it read');

const ws = new WebSocket('ws://localhost:8787/v1/realtime', {
  headers: { Authorization: `Bearer ${token}` },
});
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
log('typing…');
for (let i = 0; i < 4; i++) {
  ws.send(JSON.stringify({ type: 'typing', conversationId: conversation.id }));
  await sleep(2000);
}
await call(
  `/conversations/${conversation.id}/messages`,
  { id: randomUUID(), body: 'Got it! Messages are flowing ✅' },
  token,
);
log('replied');
ws.close();
