import { Stack } from 'expo-router';
import { largeTitleOptions } from '@/navigation/options';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function ContactsLayout() {
  const colors = useThemeColors();
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Contacts', ...largeTitleOptions(colors) }} />
    </Stack>
  );
}
