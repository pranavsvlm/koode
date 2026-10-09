import type { KeyDevice } from '@koode/shared';
import { useCallback, useEffect, useState } from 'react';
import { useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';
import { deviceCrypto } from './index';
import type { Verification } from './deviceCrypto';

export type SafetyDevice = KeyDevice & { safetyNumber: string };
export type Safety = {
  status: 'loading' | 'ready' | 'unavailable';
  devices: SafetyDevice[];
  verification: Verification;
  setVerified: (verified: boolean) => Promise<void>;
};

/**
 * Someone's devices with the safety number between each of them and this
 * device, and whether they've been verified (and still match).
 */
export function useSafety(userId: string): Safety {
  const me = useSession((s) => s.user?.id);
  const live = useChat((s) => s.mode === 'live');
  const [state, setState] = useState<Omit<Safety, 'setVerified'>>({
    status: 'loading',
    devices: [],
    verification: 'unverified',
  });

  const load = useCallback(async () => {
    if (!me || !live) return setState((s) => ({ ...s, status: 'unavailable' }));
    try {
      const crypto = deviceCrypto(me);
      const list = await crypto.devices(userId);
      const devices = await Promise.all(
        list.map(async (d) => ({
          ...d,
          safetyNumber: (await crypto.safetyNumber(userId, d.identityKey)).displayable,
        })),
      );
      setState({ status: 'ready', devices, verification: await crypto.verification(userId, list) });
    } catch {
      setState((s) => ({ ...s, status: 'unavailable' }));
    }
  }, [me, live, userId]);

  useEffect(() => {
    // Loads asynchronously; state is only set once the lookups settle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const setVerified = useCallback(
    async (verified: boolean) => {
      if (!me) return;
      await deviceCrypto(me).setVerified(userId, verified);
      await load();
    },
    [me, userId, load],
  );

  return { ...state, setVerified };
}

/** "12345 67890 …" in rows of four groups, for reading aloud. */
export function safetyRows(displayable: string): string[] {
  const groups = displayable.match(/.{1,5}/g) ?? [];
  const rows: string[] = [];
  for (let i = 0; i < groups.length; i += 4) rows.push(groups.slice(i, i + 4).join('  '));
  return rows;
}
