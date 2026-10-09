import { Call } from '@koode/shared';
import { router } from 'expo-router';
import { authClient } from '@/features/auth';
import { useChat } from '@/stores/chat';
import { callController } from './index';

let ringingScreenOpen = false;
/**
 * The in-app ringing screen reports whether it's open, so answering from a
 * notification or CallKit replaces it instead of stacking a second full-screen
 * modal on top (dismissing two at once left a blank screen).
 */
export function setRingingScreenOpen(open: boolean) {
  ringingScreenOpen = open;
}
export const isRingingScreenOpen = () => ringingScreenOpen;

/** Resolves once the live session is running (cold starts from a notification or CallKit). */
export function whenChatReady(timeoutMs = 15_000): Promise<boolean> {
  const ready = () => useChat.getState().status === 'ready' && useChat.getState().mode === 'live';
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
    const unsub = useChat.subscribe(() => {
      if (!ready()) return;
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
  });
}

/**
 * Brings a ringing call into the app (from a notification tap or CallKit).
 * `answer`: accept it and open the call screen; otherwise the in-app ringing
 * screen opens (CallRouter). Returns false if it is no longer ringing.
 */
export async function openIncomingCall(callId: string, answer: boolean): Promise<boolean> {
  if (!(await whenChatReady())) return false;
  let snap = callController.getSnapshot();
  if (snap.call?.id !== callId) {
    const call = await authClient
      .request(`/v1/calls/${encodeURIComponent(callId)}`, Call)
      .catch(() => null);
    if (call) callController.onServerCall(call);
    snap = callController.getSnapshot();
  }
  if (snap.call?.id !== callId || snap.phase !== 'incoming' || !snap.peerId) return false;
  if (answer) {
    void callController.accept();
    const href = {
      pathname: '/call/[id]',
      params: { id: snap.peerId, kind: snap.kind, accepted: '1' },
    } as const;
    if (ringingScreenOpen) router.replace(href);
    else router.push(href);
  }
  return true;
}
