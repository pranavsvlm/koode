import { create } from 'zustand';

type DevSettings = {
  /** Show built-in sample conversations instead of real ones (design review). */
  sampleData: boolean;
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
  sampleData: false,
  slowLoading: false,
  emptyData: false,
  simulateReplies: true,
  set: (patch) => set(patch),
}));
