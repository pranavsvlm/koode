import { Platform } from 'react-native';
import { KoodeCalls, type EndReason as NativeEndReason } from '../../../modules/koode-calls';
import { callApi, callController, type CallSnapshot, type EndReason } from './index';
import { openIncomingCall } from './incoming';

/**
 * iOS: keeps CallKit (the system call screen) and the app's call controller in
 * step. CallKit shows calls that arrive by VoIP push; the user's answer / end /
 * mute in the system UI drive the controller, and the controller's state ends
 * or updates the CallKit call.
 */

const showing = new Set<string>();
const waiters = new Map<string, () => void>();

/** CallKit is (or within `ms` starts) showing this call. */
export function waitForCallKit(callId: string, ms: number): Promise<boolean> {
  if (!KoodeCalls || Platform.OS !== 'ios') return Promise.resolve(false);
  if (showing.has(callId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(callId);
      resolve(false);
    }, ms);
    waiters.set(callId, () => {
      clearTimeout(timer);
      waiters.delete(callId);
      resolve(true);
    });
  });
}

const NATIVE_REASON: Record<EndReason, NativeEndReason> = {
  ended: 'remoteEnded',
  declined: 'declinedElsewhere',
  cancelled: 'unanswered',
  missed: 'unanswered',
  busy: 'failed',
  failed: 'failed',
};

/** Starts the bridge; returns a stop function. `onVoipToken` re-registers pushes. */
export function startCallKitBridge(onVoipToken: () => void): () => void {
  const K = KoodeCalls;
  if (!K || Platform.OS !== 'ios') return () => {};

  const subs = [
    K.addListener('voipToken', onVoipToken),
    K.addListener('reported', ({ callId }) => {
      showing.add(callId);
      waiters.get(callId)?.();
    }),
    K.addListener('ignored', ({ callId }) => void showing.delete(callId)),
    K.addListener('answer', ({ callId }) => {
      void openIncomingCall(callId, true).then((ok) => {
        if (!ok) K.endCall(callId, 'failed'); // already over (cancelled / answered elsewhere)
      });
    }),
    K.addListener('end', ({ callId, answered }) => {
      showing.delete(callId);
      const s = callController.getSnapshot();
      if (s.call?.id === callId) {
        void (s.phase === 'incoming' ? callController.decline() : callController.hangUp());
      } else {
        // The app never loaded this call (e.g. declined from the lock screen).
        void (answered ? callApi.end(callId) : callApi.decline(callId)).catch(() => {});
      }
    }),
    K.addListener('mute', ({ callId, muted }) => {
      const s = callController.getSnapshot();
      if (s.call?.id === callId && s.micOn === muted) void callController.toggleMic();
    }),
  ];

  let last: CallSnapshot = callController.getSnapshot();
  const unsubscribe = callController.subscribe(() => {
    const s = callController.getSnapshot();
    const id = last.call?.id;
    if (id && showing.has(id)) {
      if (s.call?.id !== id || s.phase === 'ended' || s.phase === 'idle') {
        showing.delete(id);
        K.endCall(id, s.endReason ? NATIVE_REASON[s.endReason] : 'remoteEnded');
      } else {
        if (s.phase === 'connected' && last.phase !== 'connected') K.reportConnected(id);
        if (s.micOn !== last.micOn) K.setMuted(id, !s.micOn);
      }
    }
    last = s;
  });

  void K.activeCallIds().then((ids) => ids.forEach((id) => showing.add(id)));
  K.startListening();
  return () => {
    subs.forEach((s) => s.remove());
    unsubscribe();
  };
}
