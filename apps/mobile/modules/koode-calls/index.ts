import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

type Events = {
  voipToken: (e: { token: string | null }) => void;
  /** CallKit is showing this call. */
  reported: (e: { callId: string }) => void;
  /** CallKit refused to show it (Do Not Disturb, Focus, …). */
  ignored: (e: { callId: string; reason: string }) => void;
  answer: (e: { callId: string }) => void;
  end: (e: { callId: string; answered: boolean }) => void;
  mute: (e: { callId: string; muted: boolean }) => void;
};

export type EndReason =
  'local' | 'remoteEnded' | 'answeredElsewhere' | 'declinedElsewhere' | 'unanswered' | 'failed';

type KoodeCallsModule = {
  /** Call after adding listeners: delivers queued events, then live ones. */
  startListening(): void;
  voipToken(): Promise<string | null>;
  activeCallIds(): Promise<string[]>;
  endCall(callId: string, reason: EndReason): void;
  setMuted(callId: string, muted: boolean): void;
  reportConnected(callId: string): void;
  /** Development builds only: the real VoIP push handler / CallKit answer path. */
  simulateVoipPush(payload: Record<string, unknown>): Promise<void>;
  simulateAnswer(callId: string): void;
  addListener<E extends keyof Events>(event: E, listener: Events[E]): EventSubscription;
};

/** PushKit + CallKit (iOS only); null on Android and in tests. */
export const KoodeCalls = requireOptionalNativeModule<KoodeCallsModule>('KoodeCalls');
