import '../../global.css';
import '@/theme/interop';

import { registerGlobals } from '@livekit/react-native';

import { SplashScreen, Stack, usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { AnimatedSplash } from '@/components/brand/AnimatedSplash';
import { CallRouter } from '@/features/calls/CallRouter';
import { callController } from '@/features/calls';
import { AppState } from 'react-native';
import { configureNotifications, useNotifications } from '@/features/notifications';
import { useDevTour } from '@/dev/tour';
import { DialogProvider, ToastProvider } from '@/components/ui';
import { useChat } from '@/stores/chat';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
import { ThemeProvider, useThemeColors } from '@/theme/ThemeProvider';

/** How long the app stays connected in the background before suspending. */
const BACKGROUND_GRACE_MS = 30_000;

// WebRTC globals for LiveKit (also configures the iOS audio session).
registerGlobals();

void SplashScreen.preventAutoHideAsync();
configureNotifications();

/** Wait for persisted stores so the first frame has the right theme and route. */
function useHydrated() {
  const check = () => usePreferences.persist.hasHydrated() && useSession.persist.hasHydrated();
  const [hydrated, setHydrated] = useState(check);
  useEffect(() => {
    if (hydrated) return;
    const update = () => setHydrated(check());
    const unsubs = [
      usePreferences.persist.onFinishHydration(update),
      useSession.persist.onFinishHydration(update),
    ];
    update();
    return () => unsubs.forEach((u) => u());
  }, [hydrated]);

  // Then check the keystore for a signed-in device before showing any route.
  const status = useSession((s) => s.status);
  useEffect(() => {
    if (hydrated && status === 'loading') void useSession.getState().bootstrap();
  }, [hydrated, status]);
  return hydrated && status !== 'loading';
}

function RootStack() {
  const colors = useThemeColors();
  const signedIn = useSession((s) => s.status === 'signedIn');
  const userId = useSession((s) => s.user?.id);
  const loadChat = useChat((s) => s.load);
  const live = useChat((s) => s.mode === 'live' && s.status === 'ready');
  useDevTour(process.env.EXPO_PUBLIC_DEV_TOUR);
  useNotifications(signedIn && live);
  // Development: route changes in the Metro log during screen tours.
  const pathname = usePathname();
  useEffect(() => {
    if (__DEV__ && process.env.EXPO_PUBLIC_DEV_TOUR) console.log(`[nav] ${pathname}`);
  }, [pathname]);

  useEffect(() => {
    if (signedIn && userId) void loadChat(userId);
  }, [signedIn, userId, loadChat]);

  // Reconnect / catch up when the app returns to the foreground. After 30 s
  // in the background (and never during a call) the connection closes to
  // save battery; pushes cover messages and calls meanwhile.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      if (state === 'active') useChat.getState().resume();
      else if (state === 'background')
        timer = setTimeout(() => {
          if (AppState.currentState === 'active') return; // back already
          const phase = callController.getSnapshot().phase;
          if (phase === 'idle' || phase === 'ended') useChat.getState().suspend();
        }, BACKGROUND_GRACE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[id]/index" options={{ headerShown: true }} />
        <Stack.Screen name="chat/[id]/info" options={{ headerShown: true }} />
        <Stack.Screen name="contact/[id]" options={{ headerShown: true }} />
        <Stack.Screen name="safety/[id]" options={{ headerShown: true }} />
        <Stack.Screen name="new-chat" options={{ presentation: 'modal' }} />
        <Stack.Screen
          name="attach"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.55, 0.92],
            sheetGrabberVisible: true,
            sheetCornerRadius: 28,
          }}
        />
        <Stack.Screen
          name="call/[id]"
          options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="incoming-call"
          options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="media/[id]"
          options={{
            presentation: 'transparentModal',
            animation: 'fade',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const hydrated = useHydrated();
  const [splashDone, setSplashDone] = useState(false);
  const finishSplash = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    if (hydrated) SplashScreen.hide();
  }, [hydrated]);

  if (!hydrated) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider>
          <ToastProvider>
            <DialogProvider>
              <RootStack />
              <CallRouter />
            </DialogProvider>
          </ToastProvider>
          {!splashDone && <AnimatedSplash onDone={finishSplash} />}
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
