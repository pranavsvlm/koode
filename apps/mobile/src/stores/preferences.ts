import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AccentName } from '@/theme/tokens';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type ChatTextSize = 'small' | 'default' | 'large';
export type LastSeenVisibility = 'contacts' | 'nobody';
export type NotificationPreview = 'always' | 'unlocked' | 'never';

export type Preferences = {
  appearance: AppearancePreference;
  accent: AccentName;
  chatTextSize: ChatTextSize;
  readReceipts: boolean;
  typingIndicators: boolean;
  lastSeen: LastSeenVisibility;
  screenLock: boolean;
  messageNotifications: boolean;
  groupNotifications: boolean;
  callNotifications: boolean;
  notificationPreview: NotificationPreview;
  inAppSounds: boolean;
};

type PreferencesState = Preferences & {
  set: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  setAppearance: (appearance: AppearancePreference) => void;
};

export const DEFAULT_PREFERENCES: Preferences = {
  appearance: 'system',
  accent: 'blue',
  chatTextSize: 'default',
  readReceipts: true,
  typingIndicators: true,
  lastSeen: 'contacts',
  screenLock: false,
  messageNotifications: true,
  groupNotifications: true,
  callNotifications: true,
  notificationPreview: 'always',
  inAppSounds: true,
};

/**
 * Non-sensitive, device-local preferences. Secrets belong in expo-secure-store.
 * Privacy settings that the server must enforce (read receipts, last seen)
 * are synced to the account in Phase 3/4; for now they are local only.
 */
export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      set: (key, value) => set({ [key]: value } as Partial<Preferences>),
      setAppearance: (appearance) => set({ appearance }),
    }),
    {
      name: 'koode.preferences',
      version: 2,
      storage: createJSONStorage(() => Storage),
      // v1 only had `appearance`; new keys fall back to defaults.
      migrate: (persisted) => ({ ...DEFAULT_PREFERENCES, ...(persisted as Partial<Preferences>) }),
    },
  ),
);
