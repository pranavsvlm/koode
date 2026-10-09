import { Call } from '@koode/shared';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { authClient } from '@/features/auth';
import { parsePushData, tapAction } from './policy';

/**
 * Android: runs (even headless, with the app killed) for data messages and
 * for notification action buttons that don't open the app. Defined at module
 * scope from the app entry (index.ts) so it exists before any UI.
 */
export const BACKGROUND_TASK = 'koode-background-notification';

const bodyOf = (data: Record<string, unknown> | undefined): unknown => {
  const raw = data?.body ?? data?.dataString;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  BACKGROUND_TASK,
  async ({ data, error }) => {
    if (error || !data) return;
    if ('actionIdentifier' in data) {
      // "Decline" on an incoming-call notification.
      const action = tapAction(data.notification.request.content.data, data.actionIdentifier);
      if (action?.kind === 'decline-call') {
        await authClient
          .request(`/v1/calls/${encodeURIComponent(action.callId)}/decline`, Call, {
            method: 'POST',
            body: {},
          })
          .catch(() => {});
        await Notifications.dismissNotificationAsync(data.notification.request.identifier);
      }
      return;
    }
    // The call stopped ringing (answered elsewhere, declined): remove its
    // notification. Android notifications are identified by the push's tag.
    const push = parsePushData(bodyOf(data.data));
    if (push?.type === 'call-ended') await Notifications.dismissNotificationAsync(push.callId);
  },
);
