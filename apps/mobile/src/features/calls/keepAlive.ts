import { AppRegistry } from 'react-native';
import { KEEP_ALIVE_TASK } from '../../../modules/koode-call-ui';

/**
 * Android: a headless JS task that lasts as long as a call. React Native pauses
 * JS timers while the activity is paused (another app on screen, or the call in
 * picture-in-picture) unless a headless task is running, and the call's
 * keep-alives (LiveKit's and the messaging socket's) are timers. Native code
 * (koode-call-ui `startCall`) starts the task; it ends with the call.
 */
let release: (() => void) | null = null;

// Registered on import (index.ts), before the app starts.
AppRegistry.registerHeadlessTask(
  KEEP_ALIVE_TASK,
  () => () =>
    new Promise<void>((resolve) => {
      release?.();
      release = resolve;
    }),
);

/** The call ended: let the task finish. */
export function releaseCallKeepAlive() {
  release?.();
  release = null;
}
