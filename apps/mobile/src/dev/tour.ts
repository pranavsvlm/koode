import * as Crypto from 'expo-crypto';
import { router, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { setLogLevel } from 'livekit-client';
import { KoodeCalls } from '../../modules/koode-calls';
import { useEffect } from 'react';
import { useDevSettings } from '@/dev/settings';
import { callController } from '@/features/calls';
import { startCall } from '@/features/calls/startCall';
import { handleResponse, syncPushRegistration } from '@/features/notifications';
import { ACTION } from '@/features/notifications/policy';
import { useChat } from '@/stores/chat';
import { usePreferences, type AppearancePreference } from '@/stores/preferences';
import { generateRecoveryKey } from '@/features/auth/validation';
import { useSession } from '@/stores/session';

/**
 * DEVELOPMENT ONLY: walks through every screen so the UI can be reviewed and
 * screenshotted without tapping (iOS 27 Simulators confirm every openurl).
 * Enable with `EXPO_PUBLIC_DEV_TOUR=1 npx expo start --dev-client`.
 * Each step logs `[tour] <n> <name>` to the Metro console.
 */
const STEP_MS = 3500;

/** `shotAtMs`: when to log the step (and so screenshot), default STEP_MS - 600. */
type Step = { name: string; run: () => void; shotAtMs?: number };

const go = (href: Href) => () => router.navigate(href);
const reloadChat = (patch: { slowLoading?: boolean; emptyData?: boolean }) => {
  useDevSettings.getState().set({ slowLoading: false, emptyData: false, ...patch });
  useChat.setState({ status: 'idle' });
  void useChat.getState().load();
};
const INVITE = process.env.EXPO_PUBLIC_DEV_TOUR_INVITE ?? '';

/**
 * Real registration against the local server (an end-to-end check of device
 * keys, signing, the keystore and the API on a real device/Simulator).
 * Needs an invite: `pnpm --filter @koode/server invite:create`.
 */
const signIn = () => {
  const username = `tour${Math.floor(Math.random() * 1e6)}`;
  useSession
    .getState()
    .register({
      inviteCode: INVITE.replace(/-/g, ''),
      username,
      displayName: 'Alex Rivera',
      recoveryKey: generateRecoveryKey(Crypto.getRandomBytes),
    })
    .then(
      () => console.log(`[tour-auth] registered @${username} id=${useSession.getState().user?.id}`),
      (e: unknown) =>
        console.log(`[tour-auth] FAILED ${e instanceof Error ? e.message : String(e)}`),
    );
};
export const TOUR: Step[] = [
  { name: 'welcome', run: go('/welcome') },
  { name: 'invite', run: go({ pathname: '/invite', params: { code: INVITE } }) },
  { name: 'create-profile', run: go({ pathname: '/create-profile', params: { code: INVITE } }) },
  {
    name: 'recovery-key',
    run: go({ pathname: '/recovery-key', params: { name: 'Alex Rivera', username: 'alex' } }),
  },
  { name: 'sign-in', run: go('/sign-in') },
  { name: 'chats', run: signIn },
  { name: 'chat-direct', run: go('/chat/c-maya') },
  { name: 'chat-group', run: go('/chat/c-family') },
  { name: 'group-info', run: go('/chat/c-family/info') },
  { name: 'contact', run: go('/contact/maya') },
  {
    name: 'media-viewer',
    run: go({ pathname: '/media/[id]', params: { id: 'm7', conversationId: 'c-maya' } }),
  },
  {
    name: 'attach',
    run: () => {
      router.back();
      setTimeout(
        () => router.navigate({ pathname: '/attach', params: { conversationId: 'c-maya' } }),
        400,
      );
    },
  },
  {
    name: 'calls',
    run: () => {
      router.back();
      setTimeout(go('/calls'), 400);
    },
  },
  { name: 'contacts', run: go('/contacts') },
  { name: 'new-chat', run: go('/new-chat') },
  {
    name: 'settings',
    run: () => {
      router.back();
      setTimeout(go('/settings'), 400);
    },
  },
  { name: 'profile', run: go('/settings/profile') },
  { name: 'invites', run: go('/settings/invites') },
  { name: 'devices', run: go('/settings/devices') },
  { name: 'recovery-key-settings', run: go('/settings/recovery-key') },
  { name: 'privacy', run: go('/settings/privacy') },
  { name: 'notifications', run: go('/settings/notifications') },
  { name: 'appearance', run: go('/settings/appearance') },
  {
    name: 'voice-call',
    run: go({ pathname: '/call/[id]', params: { id: 'maya', kind: 'voice' } }),
  },
  { name: 'voice-call-connected', run: () => {} },
  {
    name: 'video-call',
    run: () => {
      router.back();
      setTimeout(
        go({ pathname: '/call/[id]', params: { id: 'sofia', kind: 'video', accepted: '1' } }),
        800,
      );
    },
  },
  {
    name: 'incoming-call',
    run: () => {
      router.back();
      setTimeout(
        go({ pathname: '/incoming-call', params: { contactId: 'grandma', kind: 'voice' } }),
        800,
      );
    },
  },
  {
    name: 'chats-loading',
    shotAtMs: 1700,
    run: () => {
      router.back();
      setTimeout(() => {
        go('/chats')();
        reloadChat({ slowLoading: true });
      }, 800);
    },
  },
  { name: 'chats-empty', run: () => reloadChat({ emptyData: true }) },
  { name: 'calls-empty', run: go('/calls') },
  {
    name: 'done',
    run: () => {
      reloadChat({});
      go('/chats')();
    },
  },
];

/** `mode`: '1' keeps current appearance; 'light' / 'dark' force it (restored afterwards). */
const firstConversationId = () =>
  Object.values(useChat.getState().conversations).sort((x, y) => y.createdAt - x.createdAt)[0]?.id;

/**
 * Two-party messaging check against the real server. A peer script
 * (apps/server/scripts/peer.mjs) plays "Maya": it starts a chat with the
 * account registered here, replies, reads and types.
 */
export const MESSAGING_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      signIn();
    },
  },
  { name: 'wait-for-peer', run: () => {} },
  { name: 'chats-live', run: go('/chats') },
  {
    name: 'chat-live',
    run: () => {
      const id = firstConversationId();
      console.log(`[tour-msg] conversation ${id ?? 'NONE'}`);
      if (id) router.navigate(`/chat/${id}`);
    },
  },
  {
    name: 'send',
    run: () => {
      const id = firstConversationId();
      if (id) useChat.getState().send(id, { text: 'Hello from the Simulator 👋' });
      console.log('[tour-msg] sent');
    },
  },
  { name: 'peer-typing', run: () => {} },
  { name: 'after-reply', run: () => {} },
  {
    name: 'done',
    run: () => {
      const id = firstConversationId();
      const list = (id && useChat.getState().messages[id]) || [];
      console.log(
        `[tour-msg] final ${JSON.stringify(list.map((m) => [m.senderId === 'me' ? 'me' : 'peer', m.text, m.status]))}`,
      );
    },
  },
];

/**
 * Two-party calling check against the real server and a local LiveKit. A peer
 * script (apps/server/scripts/call-peer.mjs) plays "Maya": it calls this
 * account, joins the media room with the LiveKit CLI, hangs up, then declines
 * a call from here. Steps invoke the same handlers as the on-screen buttons.
 */
let callPeer = '';
const callLog = (label: string) => {
  const s = callController.getSnapshot();
  console.log(
    `[tour-call] ${label} ${JSON.stringify({ phase: s.phase, endReason: s.endReason, call: s.call?.state, kind: s.kind, mic: s.micOn, remote: s.remotePresent })}`,
  );
};
const logCalls = () =>
  console.log(
    `[tour-call] history ${JSON.stringify(useChat.getState().calls.map((c) => [c.direction, c.kind, c.outcome, c.durationSec]))}`,
  );

export const CALL_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      setLogLevel('info');
      signIn();
    },
  },
  { name: 'wait-for-peer', run: () => {} },
  { name: 'chats-live', run: () => (go('/chats')(), console.log('[tour-call] ready')) },
  { name: 'incoming', run: () => callLog('incoming') },
  {
    name: 'accept',
    run: () => {
      // Same as the Accept button on the incoming call screen.
      const s = callController.getSnapshot();
      callPeer = s.peerId ?? '';
      void callController.accept();
      router.replace({
        pathname: '/call/[id]',
        params: { id: callPeer, kind: s.kind, accepted: '1' },
      });
      console.log('[tour-call] accepted');
    },
  },
  { name: 'connecting', run: () => callLog('after-accept') },
  { name: 'connected', run: () => callLog('connected') },
  {
    name: 'muted',
    run: () => void callController.toggleMic().then(() => callLog('muted')),
  },
  { name: 'peer-hangup', run: () => console.log('[tour-call] hangup-please') },
  { name: 'after-hangup', run: () => callLog('after-hangup') },
  { name: 'calls-tab', run: () => (go('/calls')(), setTimeout(logCalls, 1500)) },
  {
    name: 'outgoing',
    shotAtMs: 1500,
    run: () => {
      startCall(callPeer, 'voice');
      setTimeout(() => callLog('outgoing'), 1000);
    },
  },
  { name: 'ringing', run: () => callLog('ringing') },
  { name: 'still-ringing', run: () => callLog('still-ringing') },
  { name: 'declined', run: () => callLog('declined') },
  { name: 'calls-history', run: () => (go('/calls')(), setTimeout(logCalls, 1500)) },
  { name: 'done', run: () => callLog('done') },
];

/**
 * Push notification check against the real server and the push relay in
 * simulator mode (apps/server/scripts/push-peer.mjs plays "Maya";
 * the runner script backgrounds and restores the app). The Simulator can't
 * tap "Allow", so this asks for provisional authorization: notifications are
 * delivered quietly to Notification Center instead of as banners.
 */
const pushLog = (label: string, value?: unknown) =>
  console.log(`[tour-push] ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
const presented = async () =>
  (await Notifications.getPresentedNotificationsAsync()).map((n) => ({
    title: n.request.content.title,
    body: n.request.content.body,
    data: n.request.content.data,
  }));
const tapPresented = async (
  type: string,
  action: string = Notifications.DEFAULT_ACTION_IDENTIFIER,
) => {
  const n = (await Notifications.getPresentedNotificationsAsync()).find(
    (x) => (x.request.content.data as { type?: string })?.type === type,
  );
  pushLog(`tap ${type}`, n ? n.request.content.title : 'NONE');
  if (n) await handleResponse({ notification: n, actionIdentifier: action });
};

export const PUSH_TOUR: Step[] = [
  {
    name: 'register',
    run: () => {
      useDevSettings.getState().set({ sampleData: false });
      usePreferences.getState().set('notificationsAsked', true);
      Notifications.addNotificationReceivedListener((n) =>
        pushLog('received', [
          n.request.content.title,
          n.request.content.body,
          n.request.content.data,
        ]),
      );
      void Notifications.requestPermissionsAsync({
        ios: { allowProvisional: true, allowAlert: true, allowBadge: true, allowSound: true },
      }).then((p) => {
        pushLog('permission', p.ios?.status);
        signIn();
      });
    },
  },
  {
    name: 'registered',
    run: () =>
      void (async () => {
        const token = await Notifications.getDevicePushTokenAsync().catch((e: unknown) =>
          String(e),
        );
        pushLog(
          'alert-token',
          typeof token === 'string' ? token : `${String(token.data).length} hex chars`,
        );
        await syncPushRegistration();
        pushLog('ready');
      })(),
  },
  { name: 'foreground-message', run: go('/chats') },
  { name: 'background', run: () => pushLog('background-now') },
  { name: 'returned', run: () => {} },
  { name: 'presented', run: () => void presented().then((p) => pushLog('presented', p)) },
  // "Answer" on the incoming-call notification that arrived in the background.
  {
    name: 'answer-from-notification',
    run: () => {
      const snap = () => {
        const s = callController.getSnapshot();
        return { phase: s.phase, call: s.call?.id, state: s.call?.state, reason: s.endReason };
      };
      pushLog('before-answer', snap());
      void tapPresented('call', ACTION.answer).then(() => pushLog('after-answer', snap()));
    },
  },
  { name: 'in-call', run: () => pushLog('call-state', callController.getSnapshot().phase) },
  { name: 'hangup', run: () => pushLog('hangup-please') },
  { name: 'tap-message', run: () => void tapPresented('message') },
  { name: 'after-tap', run: () => void presented().then((p) => pushLog('presented-after-tap', p)) },
  { name: 'tap-missed-call', run: () => void tapPresented('missed-call') },
  {
    // The native VoIP push handler (the Simulator has no PushKit). iOS reports
    // the call to CallKit, then ends it: the Simulator can't show the call UI.
    name: 'callkit-report',
    run: () => {
      pushLog('call-me');
      for (const e of ['reported', 'ignored', 'answer', 'end', 'mute'] as const)
        KoodeCalls?.addListener(e, (body: unknown) => pushLog(`native ${e}`, body));
      const unsub = callController.subscribe(() => {
        const s = callController.getSnapshot();
        if (s.phase !== 'incoming' || !s.call || !KoodeCalls) return;
        unsub();
        void KoodeCalls.simulateVoipPush({
          aps: {},
          body: {
            type: 'call',
            callId: s.call.id,
            callerId: s.call.callerId,
            callerName: 'Maya Chen',
            kind: s.call.kind,
          },
        });
      });
    },
  },
  {
    name: 'callkit-ended',
    run: () =>
      void (async () =>
        pushLog('callkit-ended', {
          phase: callController.getSnapshot().phase,
          callkit: await KoodeCalls?.activeCallIds(),
        }))(),
  },
  { name: 'done', run: go('/chats') },
];

export function useDevTour(mode: string | undefined) {
  const enabled = !!mode;
  useEffect(() => {
    if (!__DEV__ || !enabled) return;
    // Start signed out so onboarding screens are reachable. NOTE: this removes
    // the current device from its account on the local server.
    void useSession.getState().signOut();
    const prefs = usePreferences.getState();
    const saved = { appearance: prefs.appearance, accent: prefs.accent };
    if (mode !== 'messaging' && mode !== 'calls')
      useDevSettings.getState().set({ sampleData: true });
    if (mode === 'light' || mode === 'dark') {
      prefs.set('appearance', mode as AppearancePreference);
      prefs.set('accent', 'blue');
    }
    const restore = () => {
      usePreferences.getState().set('appearance', saved.appearance);
      usePreferences.getState().set('accent', saved.accent);
    };
    const steps =
      mode === 'messaging'
        ? MESSAGING_TOUR
        : mode === 'calls'
          ? CALL_TOUR
          : mode === 'push'
            ? PUSH_TOUR
            : TOUR;
    let i = 0;
    const tick = () => {
      const step = steps[i];
      if (!step) return;
      step.run();
      // Log after navigation settles so screenshots match the step.
      setTimeout(
        () => {
          console.log(`[tour] ${i} ${step.name}`);
          if (step.name === 'done') restore();
        },
        step.shotAtMs ?? STEP_MS - 600,
      );
      i += 1;
      timer = setTimeout(tick, STEP_MS);
    };
    let timer = setTimeout(tick, 2500);
    return () => clearTimeout(timer);
  }, [enabled, mode]);
}
