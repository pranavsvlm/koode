import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useCall } from './index';

/**
 * Opens the incoming-call screen when a call rings while the app is open.
 * (Background and locked-screen ringing use CallKit / the system UI: Phase 6.)
 */
export function CallRouter() {
  const call = useCall();
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    if (call.phase === 'incoming' && call.call && shownFor.current !== call.call.id) {
      shownFor.current = call.call.id;
      router.push({
        pathname: '/incoming-call',
        params: { contactId: call.call.callerId, kind: call.call.kind },
      });
    }
  }, [call.phase, call.call]);

  return null;
}
