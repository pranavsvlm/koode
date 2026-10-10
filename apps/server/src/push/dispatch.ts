import type { Call, Message, PushData } from '@koode/shared';
import { attachmentLabel, RING_TIMEOUT_MS } from '@koode/shared';
import { sendApns, type ApnsPush, type PushResult } from './apns';
import { sendFcm, type FcmMessage } from './fcm';

/**
 * Who gets which push. Pushes wake or alert devices that may not have the app
 * open; devices that do get the same events over the WebSocket and decide in
 * the app whether to show anything.
 *
 * Privacy: payload data never contains message text. Messages are end-to-end
 * encrypted, so alerts say only who wrote ("New message"); legacy plaintext
 * messages from before Phase 8 could show a preview where a device allows it.
 */

type Registration = {
  device_id: string;
  user_id: string;
  platform: 'ios' | 'android';
  app_id: string;
  environment: 'sandbox' | 'production';
  alert_token: string | null;
  voip_token: string | null;
  direct_messages: number;
  group_messages: number;
  calls: number;
  previews: number;
};

type Job =
  | { via: 'apns'; tokenColumn: 'alert_token' | 'voip_token'; push: ApnsPush }
  | { via: 'fcm'; push: FcmMessage };

const PREVIEW_CHARS = 180;
const MESSAGE_TTL_S = 24 * 3600;
const CALL_TTL_S = Math.ceil(RING_TIMEOUT_MS / 1000);

async function registrations(
  db: D1Database,
  userIds: string[],
  exceptDeviceId?: string,
): Promise<Registration[]> {
  if (userIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT p.* FROM push_registrations p JOIN devices d ON d.id = p.device_id
       WHERE p.user_id IN (${userIds.map(() => '?').join(',')}) AND d.revoked_at IS NULL`,
    )
    .bind(...userIds)
    .all<Registration>();
  return results.filter((r) => r.device_id !== exceptDeviceId);
}

const nowS = () => Math.floor(Date.now() / 1000);

/** Sends jobs in parallel and forgets tokens that APNs / FCM say are dead. */
async function run(env: Env, jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const db = env.DB;
  const results = await Promise.allSettled(
    jobs.map(async (job): Promise<[Job, PushResult]> => {
      const r = job.via === 'apns' ? await sendApns(env, job.push) : await sendFcm(env, job.push);
      return [job, r];
    }),
  );
  const dead: D1PreparedStatement[] = [];
  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      failed++;
      continue;
    }
    const [job, result] = r.value;
    if (result.ok) {
      sent++;
      continue;
    }
    failed++;
    if (result.unregistered) {
      const column = job.via === 'apns' ? job.tokenColumn : 'alert_token';
      dead.push(
        db
          .prepare(`UPDATE push_registrations SET ${column} = NULL WHERE ${column} = ?`)
          .bind(job.push.token),
      );
    }
  }
  if (dead.length) await db.batch(dead);
  // Counts only: never tokens or content.
  console.log(JSON.stringify({ type: 'push', sent, failed, removed: dead.length }));
}

// ——— Messages ———

export async function pushMessage(
  env: Env,
  message: Message,
  conversation: { kind: 'direct' | 'group'; title: string | null },
  recipientIds: string[],
): Promise<void> {
  const db = env.DB;
  const regs = (await registrations(db, recipientIds)).filter((r) =>
    conversation.kind === 'group' ? r.group_messages : r.direct_messages,
  );
  if (regs.length === 0) return;

  const [sender, badges] = await db.batch<{ display_name?: string; user_id?: string; n?: number }>([
    db.prepare('SELECT display_name FROM users WHERE id = ?').bind(message.senderId),
    db
      .prepare(
        `SELECT cm.user_id, SUM(MAX(c.last_seq - cm.last_read_seq, 0)) AS n
         FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.user_id IN (${recipientIds.map(() => '?').join(',')}) GROUP BY cm.user_id`,
      )
      .bind(...recipientIds),
  ]);
  const senderName = sender?.results[0]?.display_name ?? 'Someone';
  const unread = new Map((badges?.results ?? []).map((b) => [b.user_id, b.n ?? 0]));

  const group = conversation.kind === 'group';
  const title = group ? (conversation.title ?? 'Group') : senderName;
  if (message.kind === 'system') return; // group changes show in the chat, not as alerts
  // Encrypted messages: the server can't know what they say.
  const raw =
    message.encryption === 'signal'
      ? ''
      : message.body ||
        (message.attachment && message.attachment.kind !== 'encrypted'
          ? attachmentLabel({ ...message.attachment, kind: message.attachment.kind })
          : '');
  const text = raw.length > PREVIEW_CHARS ? `${raw.slice(0, PREVIEW_CHARS - 1)}…` : raw;
  const data: PushData = {
    type: 'message',
    conversationId: message.conversationId,
    messageId: message.id,
    seq: message.seq,
  };

  const jobs: Job[] = [];
  for (const r of regs) {
    const body =
      r.previews && text
        ? group
          ? `${senderName}: ${text}`
          : text
        : group
          ? `${senderName}: New message`
          : 'New message';
    const badge = unread.get(r.user_id) ?? 0;
    if (!r.alert_token) continue;
    if (r.platform === 'ios') {
      jobs.push({
        via: 'apns',
        tokenColumn: 'alert_token',
        push: {
          token: r.alert_token,
          appId: r.app_id,
          environment: r.environment,
          pushType: 'alert',
          priority: 10,
          expiration: nowS() + MESSAGE_TTL_S,
          payload: {
            aps: {
              alert: { title, body },
              sound: 'default',
              badge,
              'thread-id': message.conversationId,
              category: 'message',
            },
            body: data,
          },
        },
      });
    } else {
      jobs.push({
        via: 'fcm',
        push: {
          token: r.alert_token,
          ttlSeconds: MESSAGE_TTL_S,
          data: {
            title,
            message: body,
            channelId: 'messages',
            tag: message.conversationId,
            badge: String(badge),
            body: JSON.stringify(data),
          },
        },
      });
    }
  }
  await run(env, jobs);
}

// ——— Calls ———

const callLabel = (kind: Call['kind']) => (kind === 'video' ? 'video call' : 'voice call');

/** Rings the callee's devices: PushKit → CallKit on iOS, a high-priority data message on Android. */
export async function pushIncomingCall(env: Env, call: Call, callerName: string): Promise<void> {
  const regs = (await registrations(env.DB, [call.calleeId])).filter((r) => r.calls);
  const data: PushData = {
    type: 'call',
    callId: call.id,
    callerId: call.callerId,
    callerName,
    kind: call.kind,
  };
  const expiration = Math.floor((call.createdAt + RING_TIMEOUT_MS) / 1000);
  const jobs: Job[] = [];
  for (const r of regs) {
    if (r.platform === 'ios' && r.voip_token) {
      jobs.push({
        via: 'apns',
        tokenColumn: 'voip_token',
        push: {
          token: r.voip_token,
          appId: r.app_id,
          environment: r.environment,
          pushType: 'voip',
          priority: 10,
          expiration,
          collapseId: call.id,
          payload: { aps: {}, body: data },
        },
      });
    } else if (r.platform === 'ios' && r.alert_token) {
      // No PushKit token (e.g. the Simulator): an ordinary alert is the best we can do.
      jobs.push({
        via: 'apns',
        tokenColumn: 'alert_token',
        push: {
          token: r.alert_token,
          appId: r.app_id,
          environment: r.environment,
          pushType: 'alert',
          priority: 10,
          expiration,
          collapseId: call.id,
          payload: {
            aps: {
              alert: { title: callerName, body: `Incoming ${callLabel(call.kind)}` },
              sound: 'default',
              'interruption-level': 'time-sensitive',
              category: 'call',
            },
            body: data,
          },
        },
      });
    } else if (r.platform === 'android' && r.alert_token) {
      jobs.push({
        via: 'fcm',
        push: {
          token: r.alert_token,
          ttlSeconds: CALL_TTL_S,
          data: {
            title: callerName,
            message: `Incoming ${callLabel(call.kind)}`,
            channelId: 'calls',
            categoryId: 'call',
            tag: call.id,
            sticky: 'true',
            body: JSON.stringify(data),
          },
        },
      });
    }
  }
  await run(env, jobs);
}

/**
 * The call stopped ringing. Stops it on the callee's devices (except the one
 * that answered or declined) and, if nobody answered, leaves a missed-call
 * notification.
 */
export async function pushCallStopped(
  env: Env,
  call: Call,
  callerName: string,
  exceptDeviceId?: string,
): Promise<void> {
  const regs = (await registrations(env.DB, [call.calleeId], exceptDeviceId)).filter(
    (r) => r.calls,
  );
  const missed = call.state === 'missed' || call.state === 'cancelled';
  const ended: PushData = { type: 'call-ended', callId: call.id };
  const missedData: PushData = { type: 'missed-call', callId: call.id, callerId: call.callerId };
  const title = callerName;
  const body = `Missed ${callLabel(call.kind)}`;

  const jobs: Job[] = [];
  for (const r of regs) {
    if (r.platform === 'ios') {
      // Every PushKit push must be reported to CallKit; the app ends the call it reports.
      if (r.voip_token) {
        jobs.push({
          via: 'apns',
          tokenColumn: 'voip_token',
          push: {
            token: r.voip_token,
            appId: r.app_id,
            environment: r.environment,
            pushType: 'voip',
            priority: 10,
            expiration: nowS() + 60,
            collapseId: call.id,
            payload: { aps: {}, body: ended },
          },
        });
      }
      if (missed && r.alert_token) {
        jobs.push({
          via: 'apns',
          tokenColumn: 'alert_token',
          push: {
            token: r.alert_token,
            appId: r.app_id,
            environment: r.environment,
            pushType: 'alert',
            priority: 10,
            expiration: nowS() + MESSAGE_TTL_S,
            // Replaces the alert-style "Incoming call" fallback, if one was shown.
            collapseId: call.id,
            payload: {
              aps: {
                alert: { title, body },
                sound: 'default',
                'thread-id': 'calls',
                category: 'missed_call',
              },
              body: missedData,
            },
          },
        });
      }
    } else if (r.alert_token) {
      // Same tag as the ringing notification: replaced by "Missed call", or
      // (no title = silent) removed by the app's background task.
      jobs.push({
        via: 'fcm',
        push: {
          token: r.alert_token,
          ttlSeconds: missed ? MESSAGE_TTL_S : CALL_TTL_S,
          data: missed
            ? {
                title,
                message: body,
                channelId: 'missed-calls',
                tag: call.id,
                body: JSON.stringify(missedData),
              }
            : { tag: call.id, body: JSON.stringify(ended) },
        },
      });
    }
  }
  await run(env, jobs);
}
