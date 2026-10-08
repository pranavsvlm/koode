import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useAppColorScheme, useThemeColors } from '@/theme/ThemeProvider';

const liquidGlass =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

type GlassSurfaceProps = {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Force a scheme, e.g. "dark" on call screens. */
  scheme?: 'light' | 'dark';
  interactive?: boolean;
};

/**
 * Translucent surface: Liquid Glass on iOS 26+, a system blur on older iOS,
 * and a near-opaque tinted surface on Android (blur is costly there).
 */
export function GlassSurface({ children, style, scheme, interactive }: GlassSurfaceProps) {
  const appScheme = useAppColorScheme();
  const colors = useThemeColors();
  const resolved = scheme ?? appScheme;

  if (liquidGlass) {
    return (
      <GlassView style={style} colorScheme={resolved} isInteractive={interactive}>
        {children}
      </GlassView>
    );
  }
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        tint={resolved === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        intensity={90}
        style={[{ overflow: 'hidden' }, style]}
      >
        {children}
      </BlurView>
    );
  }
  return (
    <View
      style={[
        { backgroundColor: resolved === 'dark' ? 'rgba(29,32,38,0.94)' : `${colors.surface}F2` },
        style,
      ]}
    >
      {children}
    </View>
  );
}
