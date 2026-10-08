import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
  type Theme,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colorScheme as nativewindColorScheme, vars } from 'nativewind';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { usePreferences } from '@/stores/preferences';
import {
  cssVariablesFor,
  resolvePalette,
  type AccentName,
  type ColorScheme,
  type Palette,
} from './tokens';

function navigationTheme(scheme: ColorScheme, p: Palette): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: p.accent,
      background: p.background,
      card: p.background,
      text: p.text,
      border: p.separator,
      notification: p.danger,
    },
  };
}

type ThemeValue = { scheme: ColorScheme; accent: AccentName; colors: Palette };

const ThemeContext = createContext<ThemeValue>({
  scheme: 'light',
  accent: 'blue',
  colors: resolvePalette('light'),
});

/** The resolved (never "system") colour scheme currently applied. */
export const useAppColorScheme = () => useContext(ThemeContext).scheme;

/** Resolved hex colours, for props that cannot take a className (icons, gradients). */
export const useThemeColors = () => useContext(ThemeContext).colors;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = usePreferences((s) => s.appearance);
  const accent = usePreferences((s) => s.accent);
  const system = useColorScheme();
  const scheme: ColorScheme =
    preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;

  // Keep NativeWind's `dark:` variants and native UI chrome in sync.
  useEffect(() => {
    nativewindColorScheme.set(preference);
  }, [preference]);

  const value = useMemo<ThemeValue>(
    () => ({ scheme, accent, colors: resolvePalette(scheme, accent) }),
    [scheme, accent],
  );
  const variables = useMemo(() => vars(cssVariablesFor(scheme, accent)), [scheme, accent]);
  const navTheme = useMemo(() => navigationTheme(scheme, value.colors), [scheme, value.colors]);

  return (
    <ThemeContext.Provider value={value}>
      <NavigationThemeProvider value={navTheme}>
        <View style={[styles.fill, variables]}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          {children}
        </View>
      </NavigationThemeProvider>
    </ThemeContext.Provider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
