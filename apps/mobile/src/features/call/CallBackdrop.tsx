import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import { hashString } from '@/lib/hash';
import { avatarGradients, callColors } from '@/theme/tokens';

/** Dark, softly tinted backdrop derived from the caller's avatar colours. */
export function CallBackdrop({ id }: { id: string }) {
  const [a, b] = avatarGradients[hashString(id) % avatarGradients.length]!;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: callColors.background }]}>
      <LinearGradient
        colors={[`${a}66`, `${b}33`, '#06070A00']}
        locations={[0, 0.45, 1]}
        start={{ x: 0.2, y: 0 }}
        end={{ x: 0.8, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['#06070A00', '#06070ACC']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
