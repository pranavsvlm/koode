import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Profile = {
  displayName: string;
  username: string;
  about: string;
};

type SessionState = {
  status: 'signedOut' | 'signedIn';
  profile: Profile | null;
  /** Simulates finishing onboarding. Replaced by real device-key auth in Phase 3. */
  completeOnboarding: (profile: Profile) => void;
  updateProfile: (patch: Partial<Profile>) => void;
  signOut: () => void;
};

/**
 * DEVELOPMENT SESSION — no authentication happens here. Phase 3 replaces this
 * with invite-based registration, device keys and server-issued sessions.
 */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      status: 'signedOut',
      profile: null,
      completeOnboarding: (profile) => set({ status: 'signedIn', profile }),
      updateProfile: (patch) =>
        set((s) => (s.profile ? { profile: { ...s.profile, ...patch } } : s)),
      signOut: () => set({ status: 'signedOut', profile: null }),
    }),
    {
      name: 'koode.dev-session',
      version: 1,
      storage: createJSONStorage(() => Storage),
    },
  ),
);
