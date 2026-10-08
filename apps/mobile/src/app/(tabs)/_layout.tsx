import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useChat } from '@/stores/chat';
import { useThemeColors } from '@/theme/ThemeProvider';

export default function TabsLayout() {
  const colors = useThemeColors();
  const unread = useChat((s) =>
    Object.values(s.conversations).reduce((n, c) => n + (c.muted ? 0 : c.unreadCount), 0),
  );
  const missed = useChat((s) => s.calls.filter((c) => c.outcome === 'missed').length);

  return (
    <NativeTabs tintColor={colors.accent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right.fill" md="chat" />
        <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
        {unread > 0 && (
          <NativeTabs.Trigger.Badge>
            {unread > 99 ? '99+' : String(unread)}
          </NativeTabs.Trigger.Badge>
        )}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="calls">
        <NativeTabs.Trigger.Icon sf="phone.fill" md="call" />
        <NativeTabs.Trigger.Label>Calls</NativeTabs.Trigger.Label>
        {missed > 0 && <NativeTabs.Trigger.Badge>{String(missed)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="contacts">
        <NativeTabs.Trigger.Icon sf="person.2.fill" md="group" />
        <NativeTabs.Trigger.Label>Contacts</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf="gearshape.fill" md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
