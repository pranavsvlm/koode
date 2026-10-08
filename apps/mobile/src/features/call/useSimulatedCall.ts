import { useCallback, useEffect, useRef, useState } from 'react';

export type CallPhase =
  'calling' | 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

/**
 * DEVELOPMENT ONLY: drives call UI through realistic states with timers.
 * Phase 5 replaces this with LiveKit room events.
 */
export function useSimulatedCall({ accepted }: { accepted: boolean }) {
  const [phase, setPhase] = useState<CallPhase>(accepted ? 'connecting' : 'calling');
  const [seconds, setSeconds] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const t = timers.current;
    if (accepted) {
      t.push(setTimeout(() => setPhase('connected'), 900));
    } else {
      t.push(setTimeout(() => setPhase('ringing'), 1200));
      t.push(setTimeout(() => setPhase('connected'), 4200));
    }
    return () => t.forEach(clearTimeout);
  }, [accepted]);

  useEffect(() => {
    if (phase !== 'connected' && phase !== 'reconnecting') return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  /** Show the reconnecting state for a few seconds (dev control). */
  const simulateReconnect = useCallback(() => {
    if (phase !== 'connected') return;
    setPhase('reconnecting');
    timers.current.push(setTimeout(() => setPhase('connected'), 3000));
  }, [phase]);

  const end = useCallback(() => setPhase('ended'), []);

  return { phase, seconds, simulateReconnect, end };
}
