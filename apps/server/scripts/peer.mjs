#!/usr/bin/env node
/**
 * Development peer for end-to-end messaging checks, paired with the app's
 * messaging tour (EXPO_PUBLIC_DEV_TOUR=messaging). Plays "Maya":
 *
 *   node scripts/peer.mjs <maya-invite-code> <metro-log-path>
 *
 * Starts a chat with the app's account and says hello; decrypts the app's
 * message, marks it read, types over the WebSocket and replies. Then checks
 * what the app showed: both messages decrypted, its own message read. Also:
 * profile photos both ways (the key inside messages, ciphertext on the
 * server) and Maya's presence as the app sees it.
 */
import { call, checks, createPeer, jpegSize, log, metro, sleep, waitFor } from './lib/peer.mjs';

const [invite, metroLog] = process.argv.slice(2);
const { waitForLog, appUser } = metro(metroLog);
const { check, finish } = checks();

const app = await appUser();
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
const chat = await maya.chatWith(app.id);
await maya.sendText(chat, 'Hi from Maya 👋 (sent by the peer script)');
log('started the chat and said hello');

// Delivered before it's read: the app acknowledges on arrival, chat not open yet.
const early = await waitFor(
  async () => {
    const c = (await call('/conversations', null, maya.token)).conversations.find(
      (x) => x.id === chat,
    );
    const m = c?.members.find((x) => x.userId === app.id);
    return m && m.lastDeliveredSeq >= c.lastSeq && m;
  },
  'delivery on arrival',
  8_000,
).catch(() => null);
check(
  'app acknowledges delivery on arrival, before opening the chat',
  early !== null && early.lastReadSeq < early.lastDeliveredSeq,
  early,
);

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

// The app's profile photo: its key came inside the message.
const appPhoto = fromApp.p.profile?.avatar;
const got = appPhoto ? await maya.downloadPhoto(app.id, appPhoto) : null;
const size = got?.plain ? jpegSize(got.plain) : null;
check(
  'app’s photo: key in its message, ciphertext on the server, a 512 px JPEG with no location',
  got?.status === 200 &&
    got.sealed.subarray(0, 2).toString('hex') !== 'ffd8' &&
    size?.width === 512 &&
    size?.height === 512 &&
    !got.plain.includes('GPS'),
  { id: appPhoto?.id ?? null, size, bytes: got?.plain?.length },
);
// Maya uses it as her own photo, so the app has something to decrypt.
const mayaPhoto = got?.plain ? await maya.setPhoto(got.plain) : null;

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
const sawOnline = await waitForLog(/\[tour-msg\] presence \{"online":true/, 5000)
  .then(() => true)
  .catch(() => false);
check('app shows Maya online while she’s connected', sawOnline);
await maya.sendText(chat, 'Got it! Messages are flowing ✅');
ws.close();
log('typed and replied');
const [, offline] = await waitForLog(
  /\[tour-msg\] presence (\{"online":false,"lastSeenAt":\d+\})/,
  20_000,
).catch(() => [null, null]);
check('then offline, with when she was last seen', offline !== null, offline);

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
const [, photoLine] = await waitForLog(/\[tour-msg\] peer-photo (.*)/, 20_000);
const peerPhoto = JSON.parse(photoLine);
check(
  'app decrypted Maya’s photo (key from her message)',
  peerPhoto.decrypted && peerPhoto.id === mayaPhoto?.avatar.id && peerPhoto.size > 0,
  peerPhoto,
);

// The app acknowledges delivery of what it received (the sender's ✓✓).
const summary = async () =>
  (await call('/conversations', null, maya.token)).conversations.find((c) => c.id === chat);
const delivered = await waitFor(
  async () => {
    const c = await summary();
    const m = c.members.find((x) => x.userId === app.id);
    return m.lastDeliveredSeq >= c.lastSeq && m;
  },
  'the app’s delivery receipt',
  15_000,
).catch(() => null);
const c = await summary();
check('app acknowledged delivery of every message (sender sees ✓✓)', delivered !== null, {
  lastSeq: c.lastSeq,
  app: c.members.find((x) => x.userId === app.id),
});
finish();
