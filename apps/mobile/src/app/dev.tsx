import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { useChat } from '@/stores/chat';
import { useSession } from '@/stores/session';

/**
 * DEVELOPMENT ONLY deep link for scripted UI review, e.g.
 *   xcrun simctl openurl booted "koode://dev?action=signin"
 * Does nothing in release builds.
 */
export default function DevRoute() {
  const { action } = useLocalSearchParams<{ action?: 'signin' | 'signout' }>();
  const status = useSession((s) => s.status);

  useEffect(() => {
    if (!__DEV__) return;
    if (action === 'signin') {
      useSession.getState().completeOnboarding({
        displayName: 'Alex Rivera',
        username: 'alex',
        about: 'Family first.',
      });
    } else if (action === 'signout') {
      useChat.setState({ status: 'idle' });
      useSession.getState().signOut();
    }
  }, [action]);

  const settled =
    !__DEV__ ||
    (action === 'signin' && status === 'signedIn') ||
    (action === 'signout' && status === 'signedOut') ||
    (action !== 'signin' && action !== 'signout');
  return settled ? <Redirect href="/" /> : null;
}
