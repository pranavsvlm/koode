import { Stack } from 'expo-router';
import { detailOptions } from '@/navigation/options';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function AuthLayout() {
  const colors = useThemeColors();
  return (
    <Stack screenOptions={{ ...detailOptions(colors), title: '' }}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen
        name="recovery-key"
        options={{ gestureEnabled: false, headerBackVisible: false }}
      />
    </Stack>
  );
}
