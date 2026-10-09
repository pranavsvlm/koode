import type { Call } from '@koode/shared';
import { notifyUsers } from '../messaging/rows';
import { pushCallStopped, pushIncomingCall } from '../push/dispatch';
import { displayName } from './rows';

/**
 * Tell both people about a call's new state: realtime events for open apps,
 * pushes for the callee's devices (ring, stop ringing, missed call).
 * `wasRinging`: the call was ringing before this change.
 */
export async function publishCall(
  env: Env,
  call: Call,
  opts: { wasRinging: boolean; exceptDeviceId?: string },
): Promise<void> {
  const realtime = notifyUsers(env, [call.callerId, call.calleeId], { type: 'call', call });
  if (call.state === 'ringing' || opts.wasRinging) {
    const callerName = await displayName(env.DB, call.callerId);
    await (call.state === 'ringing'
      ? pushIncomingCall(env, call, callerName)
      : pushCallStopped(env, call, callerName, opts.exceptDeviceId));
  }
  await realtime;
}
