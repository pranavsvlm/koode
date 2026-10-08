import type { NativeStackNavigationOptions } from 'expo-router';
import { Platform } from 'react-native';
import type { Palette } from '@/theme/tokens';

/**
 * Tab-root headers: large collapsing titles over translucent bars on iOS,
 * flat themed bars on Android. Scrollables under them must set
 * `contentInsetAdjustmentBehavior="automatic"`.
 */
export function largeTitleOptions(colors: Palette): NativeStackNavigationOptions {
  return Platform.OS === 'ios'
    ? {
        headerLargeTitleEnabled: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
        headerLargeTitleStyle: { color: colors.text },
      }
    : {
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
      };
}

/** Pushed detail screens: compact title, minimal back button. */
export function detailOptions(colors: Palette): NativeStackNavigationOptions {
  return {
    headerBackButtonDisplayMode: 'minimal',
    headerShadowVisible: false,
    headerTintColor: colors.accent,
    headerTitleStyle: { color: colors.text },
    headerStyle: { backgroundColor: colors.background },
    contentStyle: { backgroundColor: colors.background },
  };
}
