import { Stack } from 'expo-router';
import { largeTitleOptions } from '@/navigation/options';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function ChatsLayout() {
  const colors = useThemeColors();
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Chats', ...largeTitleOptions(colors) }} />
    </Stack>
  );
}
