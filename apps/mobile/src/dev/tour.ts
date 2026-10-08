import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { useDevSettings } from '@/dev/settings';
import { useChat } from '@/stores/chat';
import { usePreferences, type AppearancePreference } from '@/stores/preferences';
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
const signIn = () =>
  useSession
    .getState()
    .completeOnboarding({ displayName: 'Alex Rivera', username: 'alex', about: 'Family first.' });

export const TOUR: Step[] = [
  { name: 'welcome', run: go('/welcome') },
  { name: 'invite', run: go({ pathname: '/invite', params: { code: 'K7QM4XRT9PWD' } }) },
  { name: 'create-profile', run: go('/create-profile') },
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
export function useDevTour(mode: string | undefined) {
  const enabled = !!mode;
  useEffect(() => {
    if (!__DEV__ || !enabled) return;
    // Start signed out so onboarding screens are reachable.
    useSession.getState().signOut();
    const prefs = usePreferences.getState();
    const saved = { appearance: prefs.appearance, accent: prefs.accent };
    if (mode === 'light' || mode === 'dark') {
      prefs.set('appearance', mode as AppearancePreference);
      prefs.set('accent', 'blue');
    }
    const restore = () => {
      usePreferences.getState().set('appearance', saved.appearance);
      usePreferences.getState().set('accent', saved.accent);
    };
    let i = 0;
    const tick = () => {
      const step = TOUR[i];
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
