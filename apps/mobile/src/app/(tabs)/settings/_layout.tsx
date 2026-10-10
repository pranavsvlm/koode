import { Stack } from 'expo-router';
import { detailOptions, largeTitleOptions } from '@/navigation/options';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function SettingsLayout() {
  const colors = useThemeColors();
  const detail = { ...detailOptions(colors), contentStyle: { backgroundColor: colors.background } };
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Settings', ...largeTitleOptions(colors) }} />
      <Stack.Screen name="profile" options={{ title: 'Profile', ...detail }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy & Security', ...detail }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications', ...detail }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance', ...detail }} />
      <Stack.Screen name="invites" options={{ title: 'Invitations', ...detail }} />
      <Stack.Screen name="devices" options={{ title: 'Devices', ...detail }} />
      <Stack.Screen name="recovery-key" options={{ title: 'Recovery Key', ...detail }} />
      <Stack.Screen name="licenses" options={{ title: 'Source Code & Licences', ...detail }} />
    </Stack>
  );
}
