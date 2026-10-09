import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { waitForCallKit } from './callkit';
import { isRingingScreenOpen } from './incoming';
import { callController, useCall } from './index';

/** How long iOS gets to show a ringing call with CallKit before the app shows its own screen. */
const CALLKIT_GRACE_MS = 1500;

/**
 * Opens the in-app incoming-call screen when a call rings while the app is
 * open, unless CallKit (iOS, from the VoIP push) is already showing it.
 */
export function CallRouter() {
  const call = useCall();
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    const c = call.call;
    if (call.phase !== 'incoming' || !c || shownFor.current === c.id) return;
    shownFor.current = c.id;
    void waitForCallKit(c.id, CALLKIT_GRACE_MS).then((callKit) => {
      const s = callController.getSnapshot();
      // One ringing screen at a time: an open one follows the current call.
      if (callKit || s.phase !== 'incoming' || s.call?.id !== c.id || isRingingScreenOpen()) return;
      router.push({ pathname: '/incoming-call', params: { contactId: c.callerId, kind: c.kind } });
    });
  }, [call.phase, call.call]);

  return null;
}
