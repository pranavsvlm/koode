import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { View, type ImageSourcePropType } from 'react-native';
import { hashString } from '@/lib/hash';
import { avatarGradients } from '@/theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

export type AvatarProps = {
  /** Stable id used to pick the fallback gradient. */
  id: string;
  name: string;
  size?: number;
  source?: ImageSourcePropType;
  online?: boolean;
  group?: boolean;
};

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function Avatar({ id, name, size = 48, source, online, group }: AvatarProps) {
  const gradient = avatarGradients[hashString(id) % avatarGradients.length]!;
  const dot = Math.max(10, size * 0.26);

  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel={online ? `${name}, online` : name}
    >
      {source ? (
        <Image
          source={source}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <LinearGradient
          colors={gradient}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {group ? (
            <Icon name="group" size={size * 0.42} color="#FFFFFF" />
          ) : (
            <Text
              style={{ fontSize: size * 0.38, lineHeight: size * 0.46, color: '#FFFFFF' }}
              className="font-semibold"
              allowFontScaling={false}
            >
              {initialsOf(name)}
            </Text>
          )}
        </LinearGradient>
      )}
      {online && (
        <View
          className="absolute bottom-0 right-0 rounded-full border-background bg-success"
          style={{ width: dot, height: dot, borderWidth: Math.max(2, size * 0.05) }}
        />
      )}
    </View>
  );
}
