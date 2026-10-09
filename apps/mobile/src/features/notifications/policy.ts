import { PushData, type PushRegistration, type PushSettings } from '@koode/shared';
import type { Preferences } from '@/stores/preferences';

/**
 * Pure notification rules (unit-tested): how to treat a notification while the
 * app is open, where a tap leads, and what this device registers for.
 */

/** Custom data of a Koode push (`content.data`), or null if it isn't one. */
export function parsePushData(data: unknown): PushData | null {
  const r = PushData.safeParse(data);
  return r.success ? r.data : null;
}

export type Behavior = {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
};
const SILENT: Behavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export type ForegroundContext = {
  /** The conversation on screen, if any. */
  viewingConversationId: string | null;
  inAppSounds: boolean;
};

/**
 * A notification arrived while the app is in the foreground. The app already
 * has the event over the WebSocket, so only show what the screen doesn't.
 */
export function foregroundBehavior(data: unknown, ctx: ForegroundContext): Behavior {
  const push = parsePushData(data);
  switch (push?.type) {
    case 'message':
      if (push.conversationId === ctx.viewingConversationId) return SILENT;
      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: ctx.inAppSounds,
        shouldSetBadge: true,
      };
    case 'missed-call':
      return { ...SILENT, shouldShowList: true, shouldSetBadge: true };
    // Ringing is shown by the in-app call screen; "stopped" needs no UI.
    case 'call':
    case 'call-ended':
      return SILENT;
    default:
      return { ...SILENT, shouldShowList: true };
  }
}

export const ACTION = {
  answer: 'answer',
  decline: 'decline',
  callBack: 'call_back',
} as const;

export type TapAction =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'calls' }
  | { kind: 'call-back'; userId: string }
  | { kind: 'incoming-call'; callId: string; answer: boolean }
  | { kind: 'decline-call'; callId: string }
  | null;

/** What a tap (or action button) on a notification should do. */
export function tapAction(data: unknown, actionIdentifier: string): TapAction {
  const push = parsePushData(data);
  switch (push?.type) {
    case 'message':
      return { kind: 'chat', conversationId: push.conversationId };
    case 'missed-call':
      return actionIdentifier === ACTION.callBack
        ? { kind: 'call-back', userId: push.callerId }
        : { kind: 'calls' };
    case 'call':
      if (actionIdentifier === ACTION.decline) return { kind: 'decline-call', callId: push.callId };
      return {
        kind: 'incoming-call',
        callId: push.callId,
        answer: actionIdentifier === ACTION.answer,
      };
    default:
      return null;
  }
}

export function pushSettings(p: Preferences): PushSettings {
  return {
    directMessages: p.messageNotifications,
    groupMessages: p.groupNotifications,
    calls: p.callNotifications,
    previews: p.notificationPreview !== 'never',
  };
}

export type DeviceTokens = {
  platform: 'ios' | 'android';
  appId: string;
  environment: 'sandbox' | 'production';
  /** APNs / FCM token, when notifications are allowed. */
  alertToken: string | null;
  /** iOS PushKit token (needs no notification permission). */
  voipToken: string | null;
};

/** The registration to send, or null when there is nothing to register. */
export function buildRegistration(
  t: DeviceTokens,
  settings: PushSettings,
): PushRegistration | null {
  if (!t.alertToken && !t.voipToken) return null;
  return t.platform === 'ios'
    ? {
        platform: 'ios',
        appId: t.appId,
        environment: t.environment,
        alertToken: t.alertToken,
        voipToken: t.voipToken,
        settings,
      }
    : { platform: 'android', appId: t.appId, alertToken: t.alertToken, settings };
}
