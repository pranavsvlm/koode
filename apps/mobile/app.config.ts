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

// Free Apple ID signing (Xcode's "personal team"), to install on your own iPhone
// without the paid Developer Program. Such builds have no push notifications
// and expire after 7 days (docs/RELEASE.md).
const PERSONAL_TEAM = process.env.KOODE_PERSONAL_TEAM;

// Firebase config for Android push (FCM): path to google-services.json. Not
// committed; an EAS "file" environment variable in cloud builds (docs/SETUP.md).
const GOOGLE_SERVICES = process.env.GOOGLE_SERVICES_JSON;

// One wording per permission: several plugins set the same Info.plist keys.
const CAMERA = 'Koode uses your camera for video calls and to take photos and videos to send.';
const MICROPHONE = 'Koode uses your microphone for calls, voice messages and videos.';
const PHOTOS = 'Koode lets you choose photos and videos to send.';
const SAVE_PHOTOS = 'Koode saves photos and videos you choose to your library.';

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
    appleTeamId: PERSONAL_TEAM,
    // Light, dark and tinted home-screen icons (scripts/generate-icons.py).
    icon: {
      light: './assets/icon.png',
      dark: './assets/icon-dark.png',
      tinted: './assets/icon-tinted.png',
    },
    supportsTablet: false,
    infoPlist: {
      // audio: keep call audio running in the background.
      // voip: PushKit incoming-call pushes (reported to CallKit).
      UIBackgroundModes: ['audio', 'voip'],
    },
    // App Store privacy manifest. No tracking. Collected: the profile name and an
    // account id, for app functionality. Messages, files and calls are end-to-end
    // encrypted, so the operator can't read them (not "collected").
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeUserID',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
      ],
    },
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
    // Added by the WebRTC plugin; Koode never draws over other apps. Development
    // builds keep it for React Native's debug overlay.
    blockedPermissions: variant === 'development' ? [] : ['android.permission.SYSTEM_ALERT_WINDOW'],
    // Android 12+: calls through Bluetooth earphones (asked for at the first call).
    permissions: ['android.permission.BLUETOOTH_CONNECT'],
    googleServicesFile: GOOGLE_SERVICES,
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
  plugins: [
    // Free signing can't include the push entitlement. First, so it runs last
    // (after expo-notifications adds it).
    ...(PERSONAL_TEAM ? ['./plugins/withoutPushEntitlement'] : []),
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
    // Push: the aps-environment entitlement. Development builds use APNs sandbox;
    // TestFlight and App Store builds use production.
    ['expo-notifications', { mode: variant === 'development' ? 'development' : 'production' }],
    // Voice/video calls (LiveKit over WebRTC).
    '@livekit/react-native-expo-plugin',
    [
      '@config-plugins/react-native-webrtc',
      { cameraPermission: CAMERA, microphonePermission: MICROPHONE },
    ],
    // Media (Phase 7): pick, record, save and play.
    [
      'expo-image-picker',
      { photosPermission: PHOTOS, cameraPermission: CAMERA, microphonePermission: MICROPHONE },
    ],
    'expo-document-picker',
    ['expo-audio', { microphonePermission: MICROPHONE, recordAudioAndroid: true }],
    [
      'expo-media-library',
      {
        photosPermission: PHOTOS,
        savePhotosPermission: SAVE_PHOTOS,
        // Never read photo locations.
        isAccessMediaLocationEnabled: false,
        granularPermissions: ['photo', 'video'],
      },
    ],
    // supportsPictureInPicture: Android's manifest flag, needed for video calls
    // to float (koode-call-ui). Video messages don't use picture-in-picture.
    ['expo-video', { supportsBackgroundPlayback: false, supportsPictureInPicture: true }],
    // iOS 27 requires the UIScene life cycle; Expo adopts it in SDK 58. Remove then.
    './plugins/withSceneLifecycle',
    // End-to-end encryption: Signal's libsignal (pods/Maven; see the plugin).
    './plugins/withLibSignal',
    // Dev builds reopen the last Metro server instead of showing the launcher, and
    // fall back to localhost (the Simulator's Metro) if that server is gone, e.g.
    // after the Mac's LAN IP changes.
    [
      'expo-dev-client',
      { launchMode: 'most-recent', ios: { defaultLaunchURL: 'http://localhost:8081' } },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    variant,
    // Where Koode's source is published (AGPL-3.0, offered to users in the app).
    sourceCodeUrl: process.env.KOODE_SOURCE_URL,
    // Must match the aps-environment entitlement above.
    pushEnvironment: variant === 'development' ? 'sandbox' : 'production',
    eas: EAS_PROJECT_ID ? { projectId: EAS_PROJECT_ID } : undefined,
  },
});
