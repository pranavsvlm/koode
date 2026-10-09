#!/usr/bin/env node
/**
 * Development peer for end-to-end media and group checks, paired with the
 * app's media tour (EXPO_PUBLIC_DEV_TOUR=media). Plays "Maya" and "Sam":
 *
 *   node scripts/media-peer.mjs <maya-invite> <sam-invite> <metro-log> <media-dir>
 *
 * <media-dir> holds photo.jpg, clip.mp4, poster.jpg, notes.pdf and voice.m4a.
 * Maya sends one of each (encrypted); the app's files are decrypted and
 * checked (EXIF removed, poster present, the server holding only opaque
 * ciphertext), and reactions, deletion and group changes are verified.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, checks, createPeer, log, metro, raw, waitFor } from './lib/peer.mjs';

const [mayaInvite, samInvite, metroLog, mediaDir] = process.argv.slice(2);
const { waitForLog, tourJson, appUser } = metro(metroLog);
const { check, finish } = checks();
const file = (name) => readFileSync(join(mediaDir, name));

const app = await appUser();
const maya = await createPeer({ invite: mayaInvite, name: 'maya', displayName: 'Maya Chen' });
const sam = await createPeer({ invite: samInvite, name: 'sam', displayName: 'Sam Lee' });
const chat = await maya.chatWith(app.id);
// Sam says hello too, so the app knows which Sam to add to a group later.
await sam.sendText(await sam.chatWith(app.id), 'Hi, it’s Sam');

// 1. Maya sends a photo, a video (with poster), a document and a voice message.
await waitForLog(/\[tour-media\] ready/);
await maya.sendFile(chat, file('photo.jpg'), {
  kind: 'image',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 900,
});
await maya.sendFile(
  chat,
  file('clip.mp4'),
  { kind: 'video', mimeType: 'video/mp4', width: 640, height: 360, durationMs: 3000 },
  file('poster.jpg'),
);
await maya.sendFile(chat, file('notes.pdf'), {
  kind: 'document',
  mimeType: 'application/pdf',
  name: 'Agenda.pdf',
});
await maya.sendFile(chat, file('voice.m4a'), {
  kind: 'voice',
  mimeType: 'audio/mp4',
  durationMs: 2000,
  waveform: [0.2, 0.6, 1, 0.5, 0.3],
});
log('files-sent');

const downloaded = await tourJson('media', 'downloaded');
const original = {
  image: file('photo.jpg').length,
  video: file('clip.mp4').length,
  document: file('notes.pdf').length,
  voice: file('voice.m4a').length,
};
check(
  'app decrypted all four of Maya’s files byte-for-byte in size',
  downloaded.length === 4 && downloaded.every(([kind, size]) => size === original[kind]),
  downloaded,
);

// 2. What the app sent: decrypt and inspect.
const appFiles = async () =>
  (await maya.history(chat)).filter((x) => x.m.senderId === app.id && x.m.kind === 'attachment');
const fromApp = await waitFor(async () => {
  const list = await appFiles();
  return list.length >= 4 && list;
}, 'four files from the app');
const byKind = Object.fromEntries(fromApp.map((x) => [x.p.attachment.kind, x]));
const open = (x, part = 'content') =>
  maya.download(
    x.m.attachment.id,
    part === 'content' ? x.p.attachment.content : x.p.attachment.thumbnail,
    part,
  );

check(
  'server sees every file as opaque ciphertext',
  fromApp.every(
    (x) =>
      x.m.attachment.kind === 'encrypted' && x.m.attachment.mimeType === 'application/octet-stream',
  ),
);
{
  const { plain } = await open(byKind.image);
  check(
    'photo: JPEG, GPS and camera make removed, preview inside the envelope',
    plain[0] === 0xff &&
      plain[1] === 0xd8 &&
      !plain.includes(Buffer.from([0x88, 0x25])) &&
      !plain.includes(Buffer.from('TestCam')) &&
      !!byKind.image.p.attachment.preview,
    { w: byKind.image.p.attachment.width, h: byKind.image.p.attachment.height },
  );
}
{
  const { plain } = await open(byKind.video);
  const poster = await open(byKind.video, 'thumbnail');
  check(
    'video: decrypts at its size; encrypted poster decrypts to a JPEG',
    plain.length === byKind.video.p.attachment.sizeBytes && poster.plain[0] === 0xff,
    { durationMs: byKind.video.p.attachment.durationMs },
  );
}
{
  const { plain } = await open(byKind.document);
  check(
    'document: name and type only inside the envelope; PDF decrypts',
    plain.subarray(0, 4).toString() === '%PDF' &&
      byKind.document.p.attachment.name === 'Trip notes.pdf',
    { name: byKind.document.p.attachment.name, type: byKind.document.p.attachment.mimeType },
  );
}
{
  const { plain } = await open(byKind.voice);
  check(
    'voice: M4A decrypts, waveform inside the envelope',
    plain.subarray(4, 8).toString() === 'ftyp' && byKind.voice.p.attachment.waveform?.length > 0,
  );
}
await maya.react(chat, byKind.image.m.id, '❤️');
log('reacted ❤️ to the app’s photo');

// 3. The app's reaction and deletion.
await waitForLog(/\[tour-media\] reacted/);
const mayaPhoto = (await maya.history(chat)).find(
  (x) => x.m.senderId === maya.user.id && x.m.kind === 'attachment',
);
const reaction = await waitFor(
  async () =>
    (await maya.history(chat)).find(
      (x) => x.m.kind === 'reaction' && x.m.senderId === app.id && x.m.targetId === mayaPhoto.m.id,
    ),
  'the app’s reaction',
  20_000,
);
check('app’s 👍 on Maya’s photo (encrypted)', reaction.p?.emoji === '👍', reaction.p);
await waitForLog(/\[tour-media\] deleted/);
const doc = (
  await call(`/conversations/${chat}/messages?limit=100`, undefined, maya.token)
).messages.find((m) => m.id === byKind.document.m.id);
const gone = await raw(`/attachments/${byKind.document.m.attachment.id}/content`, maya.token);
check(
  'deleted for everyone: marker only, ciphertext and file gone',
  !!doc.deletedAt && doc.envelopes.length === 0 && !doc.attachment && gone.status === 404,
);
const myReactions = await tourJson('media', 'my-photo-reactions');
check('app shows Maya’s ❤️ on its photo', JSON.stringify(myReactions).includes('❤️'), myReactions);

// A voice message recorded in the app (Simulator microphone).
await waitForLog(/\[tour-media\] recorded/);
const recorded = await waitFor(
  async () => {
    const voices = (await appFiles()).filter((x) => x.p?.attachment.kind === 'voice');
    return voices.length >= 2 && voices.at(-1);
  },
  'the recorded voice message',
  30_000,
);
{
  const { plain } = await open(recorded);
  check('voice recorded in the app decrypts to M4A', plain.subarray(4, 8).toString() === 'ftyp', {
    durationMs: recorded.p.attachment.durationMs,
    points: recorded.p.attachment.waveform?.length,
  });
}

// 4. Group: Maya was removed, Sam was added and made admin.
const [, groupId] = await waitForLog(/\[tour-media\] group-done "([\w-]+)"/);
const mayaAccess = await raw(`/conversations/${groupId}/messages`, maya.token);
const group = await call(`/conversations/${groupId}`, undefined, sam.token);
const events = (await call(`/conversations/${groupId}/messages`, undefined, sam.token)).messages
  .filter((m) => m.kind === 'system')
  .map((m) => m.system.action);
check(
  'group: Maya lost access; renamed; Sam is admin; changes recorded',
  mayaAccess.status === 404 &&
    group.title === 'Cousins' &&
    group.members.find((m) => m.userId === sam.user.id)?.role === 'admin' &&
    ['created', 'added', 'promoted', 'renamed', 'removed'].every((a) => events.includes(a)),
  { title: group.title, events },
);
finish();
