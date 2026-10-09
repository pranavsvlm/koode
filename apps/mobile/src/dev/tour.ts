import * as Crypto from 'expo-crypto';
import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { useDevSettings } from '@/dev/settings';
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

export function useDevTour(mode: string | undefined) {
  const enabled = !!mode;
  useEffect(() => {
    if (!__DEV__ || !enabled) return;
    // Start signed out so onboarding screens are reachable. NOTE: this removes
    // the current device from its account on the local server.
    void useSession.getState().signOut();
    const prefs = usePreferences.getState();
    const saved = { appearance: prefs.appearance, accent: prefs.accent };
    if (mode !== 'messaging') useDevSettings.getState().set({ sampleData: true });
    if (mode === 'light' || mode === 'dark') {
      prefs.set('appearance', mode as AppearancePreference);
      prefs.set('accent', 'blue');
    }
    const restore = () => {
      usePreferences.getState().set('appearance', saved.appearance);
      usePreferences.getState().set('accent', saved.accent);
    };
    const steps = mode === 'messaging' ? MESSAGING_TOUR : TOUR;
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
