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
import { cssVariablesFor, palette, type ColorScheme } from './tokens';

const themeVariables = {
  light: vars(cssVariablesFor('light')),
  dark: vars(cssVariablesFor('dark')),
};

function navigationTheme(scheme: ColorScheme): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const p = palette[scheme];
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

const ColorSchemeContext = createContext<ColorScheme>('light');

/** The resolved (never "system") colour scheme currently applied. */
export const useAppColorScheme = () => useContext(ColorSchemeContext);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = usePreferences((s) => s.appearance);
  const system = useColorScheme();
  const scheme: ColorScheme =
    preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;

  // Keep NativeWind's `dark:` variants and native UI chrome in sync.
  useEffect(() => {
    nativewindColorScheme.set(preference);
  }, [preference]);

  const navTheme = useMemo(() => navigationTheme(scheme), [scheme]);

  return (
    <ColorSchemeContext.Provider value={scheme}>
      <NavigationThemeProvider value={navTheme}>
        <View style={[styles.fill, themeVariables[scheme]]}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          {children}
        </View>
      </NavigationThemeProvider>
    </ColorSchemeContext.Provider>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
