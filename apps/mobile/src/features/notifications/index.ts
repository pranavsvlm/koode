import { OkResponse } from '@koode/shared';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { KoodeCalls } from '../../../modules/koode-calls';
import { authClient } from '@/features/auth';
import { startCallKitBridge } from '@/features/calls/callkit';
import { callApi, callController } from '@/features/calls';
import { openIncomingCall, whenChatReady } from '@/features/calls/incoming';
import { startCall } from '@/features/calls/startCall';
import { useChat } from '@/stores/chat';
import { usePreferences, type Preferences } from '@/stores/preferences';
import { BACKGROUND_TASK } from './background';
import { clearNotifications } from './clear';
import { ACTION, foregroundBehavior, pushSettings, tapAction, type DeviceTokens } from './policy';
import { createRegistrar } from './registrar';

let viewing: string | null = null;

/** The chat screen reports which conversation is open (no banners for it). */
export function setViewingConversation(id: string | null) {
  viewing = id;
  if (id) void dismissWhere((d) => d.conversationId === id);
}

async function dismissWhere(match: (data: Record<string, unknown>) => boolean) {
  const shown = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  await Promise.all(
    shown
      .filter((n) => match((n.request.content.data ?? {}) as Record<string, unknown>))
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
  );
}

let configured = false;
/** Handler, Android channels and action buttons. Safe to call more than once. */
export function configureNotifications() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async (n) =>
      foregroundBehavior(n.request.content.data, {
        viewingConversationId: viewing,
        inAppSounds: usePreferences.getState().inAppSounds,
      }),
  });

  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      // Hidden on a secure lock screen when the phone hides sensitive content.
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      showBadge: true,
    });
    void Notifications.setNotificationChannelAsync('calls', {
      name: 'Incoming calls',
      importance: Notifications.AndroidImportance.MAX,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      vibrationPattern: [0, 800, 600, 800, 600, 800],
      // No `sound`: the channel uses the phone's default (a name would have to
      // be a sound file bundled with the app).
    });
    void Notifications.setNotificationChannelAsync('missed-calls', {
      name: 'Missed calls',
      importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }

  // iOS only: what shows when the phone's "Show Previews" hides the text.
  // (Android refuses categories without actions.)
  if (Platform.OS === 'ios')
    void Notifications.setNotificationCategoryAsync('message', [], {
      previewPlaceholder: 'Message',
      showTitle: true,
    });
  void Notifications.setNotificationCategoryAsync('call', [
    { identifier: ACTION.answer, buttonTitle: 'Answer', options: { opensAppToForeground: true } },
    {
      identifier: ACTION.decline,
      buttonTitle: 'Decline',
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);
  void Notifications.setNotificationCategoryAsync('missed_call', [
    {
      identifier: ACTION.callBack,
      buttonTitle: 'Call Back',
      options: { opensAppToForeground: true },
    },
  ]);
}

// ——— Registration ———

const appId =
  (Platform.OS === 'ios'
    ? Constants.expoConfig?.ios?.bundleIdentifier
    : Constants.expoConfig?.android?.package) ?? '';
const environment: 'sandbox' | 'production' =
  Constants.expoConfig?.extra?.pushEnvironment === 'production' ? 'production' : 'sandbox';

export async function notificationsAllowed(): Promise<boolean> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return true;
  const s = p.ios?.status;
  return (
    s === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    s === Notifications.IosAuthorizationStatus.EPHEMERAL
  );
}

async function deviceTokens(): Promise<DeviceTokens> {
  let alertToken: string | null = null;
  if (await notificationsAllowed()) {
    try {
      alertToken = String((await Notifications.getDevicePushTokenAsync()).data);
    } catch {
      alertToken = null; // e.g. no APNs/FCM configuration in this build
    }
  }
  return {
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    appId,
    environment,
    alertToken,
    // PushKit needs no notification permission: calls ring even if alerts are off.
    voipToken: (await KoodeCalls?.voipToken().catch(() => null)) ?? null,
  };
}

const registrar = createRegistrar({
  tokens: deviceTokens,
  settings: () => pushSettings(usePreferences.getState()),
  put: (body) => authClient.request('/v1/push', OkResponse, { method: 'PUT', body }),
  remove: () => authClient.request('/v1/push', OkResponse, { method: 'DELETE' }),
});

export const syncPushRegistration = () =>
  registrar.sync().catch((e: unknown) => {
    if (__DEV__) console.log(`[push] registration failed: ${String(e)}`);
  });

/** Shows the system prompt (once it's been answered, iOS only shows Settings). */
export async function requestNotificationPermission(): Promise<boolean> {
  usePreferences.getState().set('notificationsAsked', true);
  const r = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  void syncPushRegistration();
  return r.granted;
}

// ——— Taps ———

/** Acts on a tap or action button (exported for the development screen tour). */
export async function handleResponse(response: Notifications.NotificationResponse) {
  const { data } = response.notification.request.content;
  const action = tapAction(data, response.actionIdentifier);
  if (!action) return;
  if (!(await whenChatReady())) return;
  switch (action.kind) {
    case 'chat':
      router.push({ pathname: '/chat/[id]', params: { id: action.conversationId } });
      break;
    case 'calls':
      router.navigate('/calls');
      break;
    case 'call-back':
      startCall(action.userId, 'voice');
      break;
    case 'incoming-call':
      if (!(await openIncomingCall(action.callId, action.answer))) router.navigate('/calls');
      break;
    case 'decline-call':
      await callApi.decline(action.callId).catch(() => {});
      break;
  }
  void Notifications.dismissNotificationAsync(response.notification.request.identifier);
}

const SETTING_KEYS: (keyof Preferences)[] = [
  'messageNotifications',
  'groupNotifications',
  'callNotifications',
  'notificationPreview',
];

/**
 * Wires notifications for a live, signed-in session: permission (asked once),
 * push registration, CallKit, taps (including the one that launched the app)
 * and the app icon badge.
 */
export function useNotifications(active: boolean) {
  useEffect(() => {
    if (!active) return;
    configureNotifications();
    if (__DEV__) {
      // Development check: what was delivered while the app was closed.
      void Notifications.getPresentedNotificationsAsync().then((shown) =>
        console.log(
          `[push] presented ${JSON.stringify(shown.map((n) => [n.request.content.title, n.request.content.body, (n.request.content.data as { type?: string })?.type]))}`,
        ),
      );
    }
    const prefs = usePreferences.getState();
    if (!prefs.notificationsAsked) void requestNotificationPermission();
    else void syncPushRegistration();
    if (Platform.OS === 'android')
      void Notifications.registerTaskAsync(BACKGROUND_TASK).catch(() => {});

    const stopCallKit = startCallKitBridge(() => void syncPushRegistration());
    const subs = [
      Notifications.addPushTokenListener(() => void syncPushRegistration()),
      Notifications.addNotificationResponseReceivedListener((r) => void handleResponse(r)),
      AppState.addEventListener('change', (s) => {
        if (s === 'active') void syncPushRegistration(); // permission may have changed in Settings
      }),
    ];
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (!r) return;
      void Notifications.clearLastNotificationResponseAsync();
      void handleResponse(r);
    });
    const unsubPrefs = usePreferences.subscribe((s, prev) => {
      if (SETTING_KEYS.some((k) => s[k] !== prev[k])) void syncPushRegistration();
    });

    // Badge = unread messages; ringing notifications go once the call stops.
    let badge = -1;
    const updateBadge = () => {
      const unread = Object.values(useChat.getState().conversations).reduce(
        (n, c) => n + c.unreadCount,
        0,
      );
      if (unread !== badge) void Notifications.setBadgeCountAsync((badge = unread));
    };
    updateBadge();
    const unsubChat = useChat.subscribe(updateBadge);
    let ringing: string | null = null;
    const unsubCall = callController.subscribe(() => {
      const s = callController.getSnapshot();
      if (s.phase === 'incoming' && s.call) ringing = s.call.id;
      else if (ringing) {
        const id = ringing;
        ringing = null;
        // Only the ringing one: a missed-call notification for the same call stays.
        void dismissWhere((d) => d.type === 'call' && d.callId === id);
      }
    });

    return () => {
      stopCallKit();
      subs.forEach((s) => s.remove());
      unsubPrefs();
      unsubChat();
      unsubCall();
      // Signed out: the server dropped the registration; clear what's on screen.
      registrar.reset();
      clearNotifications();
    };
  }, [active]);
}
