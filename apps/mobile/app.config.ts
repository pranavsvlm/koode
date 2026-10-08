import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Build variants share one codebase but install side by side on a device.
 * Set APP_VARIANT in eas.json build profiles (or your shell for local builds).
 */
type Variant = 'development' | 'preview' | 'production';

const variant: Variant = (process.env.APP_VARIANT as Variant | undefined) ?? 'development';

// Change this to a reverse-DNS identifier you own before the first EAS build.
const BUNDLE_ID_BASE = 'com.navoasis.koode';

// Printed by `npx eas-cli init` (not a secret). Required for EAS Build.
const EAS_PROJECT_ID: string | undefined = undefined;

const VARIANTS: Record<Variant, { name: string; id: string }> = {
  development: { name: 'Koode Dev', id: `${BUNDLE_ID_BASE}.dev` },
  preview: { name: 'Koode Preview', id: `${BUNDLE_ID_BASE}.preview` },
  production: { name: 'Koode', id: BUNDLE_ID_BASE },
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: VARIANTS[variant].name,
  slug: 'koode',
  scheme: 'koode',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: VARIANTS[variant].id,
    supportsTablet: false,
  },
  android: {
    package: VARIANTS[variant].id,
    adaptiveIcon: {
      backgroundColor: '#0B0C10',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 120,
        resizeMode: 'contain',
        backgroundColor: '#FFFFFF',
        dark: { image: './assets/splash-icon.png', backgroundColor: '#0B0C10' },
      },
    ],
    'expo-font',
    'expo-secure-store',
    'expo-sqlite',
    'expo-image',
    // iOS 27 requires the UIScene life cycle; Expo adopts it in SDK 58. Remove then.
    './plugins/withSceneLifecycle',
    // Dev builds reopen the last Metro server instead of showing the launcher.
    ['expo-dev-client', { launchMode: 'most-recent' }],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    variant,
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
  },
});
