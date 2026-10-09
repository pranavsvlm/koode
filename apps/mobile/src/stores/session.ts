import type { User } from '@koode/shared';
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clearNotifications } from '@/features/notifications/clear';
import { authClient } from '@/features/auth';
import { useChat } from './chat';

type SessionState = {
  /** `loading` until the keystore has been checked at startup. */
  status: 'loading' | 'signedOut' | 'signedIn';
  /** Cached profile (non-secret) so the UI renders offline. */
  user: User | null;
  bootstrap: () => Promise<void>;
  register: (input: {
    inviteCode: string;
    username: string;
    displayName: string;
    recoveryKey: string;
  }) => Promise<void>;
  recover: (input: { username: string; recoveryKey: string }) => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: { displayName?: string; about?: string }) => Promise<void>;
  signOut: () => Promise<void>;
};

/**
 * Account session. Secrets (device key, refresh token) live only in the
 * keystore via `authClient`; this store holds UI state and the profile.
 */
export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      status: 'loading',
      user: null,

      bootstrap: async () => {
        const signedIn = await authClient.hasDevice();
        set({ status: signedIn ? 'signedIn' : 'signedOut', ...(signedIn ? {} : { user: null }) });
        if (signedIn) void get().refreshProfile();
      },

      register: async (input) => {
        const session = await authClient.register(input);
        set({ status: 'signedIn', user: session.user });
      },

      recover: async (input) => {
        const session = await authClient.recover(input);
        set({ status: 'signedIn', user: session.user });
      },

      refreshProfile: async () => {
        try {
          set({ user: await authClient.me() });
        } catch {
          // Offline or signed out elsewhere; the sign-out callback handles the latter.
        }
      },

      updateProfile: async (patch) => {
        set({ user: await authClient.updateProfile(patch) });
      },

      signOut: async () => {
        await authClient.logout();
        await useChat.getState().unload();
        clearNotifications();
        set({ status: 'signedOut', user: null });
      },
    }),
    {
      name: 'koode.session',
      version: 1,
      storage: createJSONStorage(() => Storage),
      partialize: (s) => ({ user: s.user }),
    },
  ),
);

// The device was revoked or its key rejected: drop to the signed-out flow.
authClient.setOnSignedOut(() => {
  void useChat.getState().unload();
  clearNotifications();
  useSession.setState({ status: 'signedOut', user: null });
});
