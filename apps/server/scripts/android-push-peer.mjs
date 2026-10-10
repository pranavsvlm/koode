#!/usr/bin/env node
/**
 * Android push (FCM) check, paired with the app's push tour on the emulator
 * (a preview-package build with google-services.json) and the local Worker
 * with FCM_SERVICE_ACCOUNT. Plays "Maya":
 *
 *   node scripts/android-push-peer.mjs <maya-invite> <metro-log> <flag-dir>
 *
 * The runner backgrounds, then kills, the app when the flag files appear;
 * this script sends a message (and a call) each time and reports what the
 * notification shade showed (the runner writes it to <flag-dir>/shade-*.txt).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { call, checks, createPeer, metro, sleep, waitFor } from './lib/peer.mjs';

const [invite, metroLog, flags] = process.argv.slice(2);
const { waitForLog, appUser } = metro(metroLog);
const { check, finish } = checks();
const flag = (name) => `${flags}/${name}`;
const waitFlag = (name, ms = 60_000) => waitFor(async () => existsSync(flag(name)), name, ms);

const app = await appUser();
const maya = await createPeer({ invite, name: 'maya', displayName: 'Maya Chen' });
await waitForLog(/\[tour-push\] ready/);
const regs = JSON.parse(
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--json',
      '--command',
      `SELECT platform, app_id, alert_token IS NOT NULL AS has_token FROM push_registrations WHERE user_id = '${app.id.replace(/'/g, '')}'`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ),
)[0].results;
check(
  'app registered for FCM push',
  regs.some((r) => r.platform === 'android' && r.has_token),
  regs,
);

const chat = await maya.chatWith(app.id);
await maya.sendText(chat, 'Hello while Koode is open');
await sleep(3000);

// 1. In the background.
writeFileSync(flag('go-background'), '');
await waitFlag('backgrounded');
await sleep(2000);
await maya.sendText(chat, 'Secret text sent while in the background');
writeFileSync(flag('sent-background'), '');
await waitFlag('shade-background.txt');
const bg = readFileSync(flag('shade-background.txt'), 'utf8');
check('notification while in the background', /Maya Chen/.test(bg), bg.trim().slice(0, 200));
check('no message text in the notification', !/Secret text/.test(bg));

// 2. Closed (process killed, not force-stopped): FCM starts the app to show it.
writeFileSync(flag('go-kill'), '');
await waitFlag('killed');
await sleep(2000);
await maya.sendText(chat, 'Secret text sent while closed');
await sleep(500);
const ringing = await maya.startCall(app.id, 'voice');
writeFileSync(flag('sent-closed'), '');
await waitFlag('shade-closed.txt');
const closed = readFileSync(flag('shade-closed.txt'), 'utf8');
check(
  'notification while Koode is closed',
  /New message/.test(closed),
  closed.trim().slice(0, 300),
);
check('incoming call notification while closed', /call/i.test(closed), closed.trim().slice(0, 300));
await call(`/calls/${ringing.call.id}/end`, {}, maya.token).catch(() => {});

// 3. Delivered: the ✓✓ once the phone has it (it may need the app to open).
const delivered = await waitFor(
  async () => {
    const c = (await call('/conversations', null, maya.token)).conversations.find(
      (x) => x.id === chat,
    );
    const m = c.members.find((x) => x.userId === app.id);
    return m.lastDeliveredSeq >= c.lastSeq ? m : null;
  },
  'delivery',
  20_000,
).catch(() => null);
check('✓✓ while Koode is closed (delivery confirmed from the push)', delivered !== null, delivered);
finish();
