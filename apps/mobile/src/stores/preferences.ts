import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type AppearancePreference = 'system' | 'light' | 'dark';

type PreferencesState = {
  appearance: AppearancePreference;
  setAppearance: (appearance: AppearancePreference) => void;
};

/** Non-sensitive, device-local UI preferences. Secrets belong in expo-secure-store. */
export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      appearance: 'system',
      setAppearance: (appearance) => set({ appearance }),
    }),
    {
      name: 'koode.preferences',
      version: 1,
      storage: createJSONStorage(() => Storage),
    },
  ),
);
