import { create } from 'zustand';

type DevSettings = {
  /** Show loading skeletons for 1.5 s on first load. */
  slowLoading: boolean;
  /** Start with no conversations, calls or contacts, to review empty states. */
  emptyData: boolean;
  /** Contacts "type" and reply to messages you send, to exercise receipts and typing. */
  simulateReplies: boolean;
  set: (patch: Partial<Omit<DevSettings, 'set'>>) => void;
};

/** Development-only switches for reviewing UI states. Not persisted. */
export const useDevSettings = create<DevSettings>((set) => ({
  slowLoading: false,
  emptyData: false,
  simulateReplies: true,
  set: (patch) => set(patch),
}));
