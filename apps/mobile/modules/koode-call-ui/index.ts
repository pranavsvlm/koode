import { requireOptionalNativeModule, requireNativeViewManager } from 'expo-modules-core';
import { Platform, type ViewProps } from 'react-native';
import type { ComponentType } from 'react';

type KoodeCallUIModule = {
  /** Screen off while the phone is at the ear (voice calls on the earpiece). */
  setProximity(enabled: boolean): Promise<void>;
  /** Android: float the video call when leaving the app (aspect width:height). */
  setPictureInPicture(enabled: boolean, width: number, height: number): Promise<void>;
};

/** Null in tests and in builds without the module. */
export const KoodeCallUI = requireOptionalNativeModule<KoodeCallUIModule>('KoodeCallUI');

export type KoodeVideoViewProps = ViewProps & {
  /** A WebRTC MediaStream URL (`mediaStream.toURL()`). */
  streamURL: string | null;
  mirror?: boolean;
  /** Corner radius in points; the video is clipped to it. */
  cornerRadius?: number;
};

/** Android only: WebRTC video that can have rounded corners (TextureView). */
export const KoodeVideoView: ComponentType<KoodeVideoViewProps> | null =
  Platform.OS === 'android' && KoodeCallUI ? requireNativeViewManager('KoodeCallUI') : null;
