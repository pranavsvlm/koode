import { Image } from 'expo-image';

/** The Koode mark (same artwork as the native splash). */
export function KoodeMark({ size = 120 }: { size?: number }) {
  return (
    <Image
      source={require('../../../assets/splash-icon.png')}
      style={{ width: size, height: size }}
      accessibilityLabel="Koode"
    />
  );
}
