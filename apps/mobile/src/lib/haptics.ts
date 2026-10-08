import * as Haptics from 'expo-haptics';

// Haptics are a nicety: never let a failure (unsupported device, web) surface.
const safe = (fn: () => Promise<void>) => () => {
  fn().catch(() => {});
};

export const haptics = {
  tap: safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  press: safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  selection: safe(() => Haptics.selectionAsync()),
  success: safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
