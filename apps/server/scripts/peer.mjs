#!/usr/bin/env node
/**
 * Development peer for end-to-end messaging checks, paired with the app's
 * messaging tour (EXPO_PUBLIC_DEV_TOUR=messaging). Plays "Maya":
 *
 *   node scripts/peer.mjs <maya-invite-code> <metro-log-path>
 *
 * Starts a chat with the app's account and says hello; decrypts the app's
 * message, marks it read, types over the WebSocket and replies. Then checks
 * what the app showed: both messages decrypted, its own message read.
 */
import { call, checks, createPeer, log, metro, sleep, waitFor } from './lib/peer.mjs';

const [invite, metroLog] = process.argv.slice(2);
const { waitForLog, appUser } = metro(metroLog);
const { check, finish } = checks();

const app = await appUser();
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
const chat = await maya.chatWith(app.id);
await maya.sendText(chat, 'Hi from Maya 👋 (sent by the peer script)');
log('started the chat and said hello');

await waitForLog(/\[tour-msg\] sent/);
const fromApp = await waitFor(
  async () => (await maya.history(chat)).find((x) => x.m.senderId === app.id && x.p),
  'the app’s message',
);
check(
  'decrypted the app’s message',
  fromApp.p.body === 'Hello from the Simulator 👋',
  fromApp.p.body,
);
await call(`/conversations/${chat}/receipts`, { read: fromApp.m.seq }, maya.token);

const ws = new WebSocket('ws://localhost:8787/v1/realtime', {
  headers: { Authorization: `Bearer ${maya.token}` },
});
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
for (let i = 0; i < 4; i++) {
  ws.send(JSON.stringify({ type: 'typing', conversationId: chat }));
  await sleep(2000);
}
await maya.sendText(chat, 'Got it! Messages are flowing ✅');
ws.close();
log('typed and replied');

const [, final] = await waitForLog(/\[tour-msg\] final (.*)/);
const shown = JSON.parse(final);
check(
  'app shows both of Maya’s messages, decrypted',
  shown
    .filter(([who]) => who === 'peer')
    .map(([, text]) => text)
    .join('|') === 'Hi from Maya 👋 (sent by the peer script)|Got it! Messages are flowing ✅',
  shown,
);
check(
  'app shows its message as read',
  shown.some(([who, , status]) => who === 'me' && status === 'read'),
);
finish();
