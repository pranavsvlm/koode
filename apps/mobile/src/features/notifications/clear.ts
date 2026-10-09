import * as Notifications from 'expo-notifications';

/** Signed out: nothing from the old session stays on screen or on the app icon. */
export function clearNotifications() {
  void Notifications.dismissAllNotificationsAsync().catch(() => {});
  void Notifications.setBadgeCountAsync(0).catch(() => {});
}
