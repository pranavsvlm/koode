import { ScrollView, View } from 'react-native';
import { Icon, ListRow, ListSection, Text } from '@/components/ui';
import { usePreferences, type NotificationPreview } from '@/stores/preferences';

const PREVIEW: { value: NotificationPreview; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'unlocked', label: 'When Unlocked' },
  { value: 'never', label: 'Never' },
];

export default function NotificationsScreen() {
  const p = usePreferences();

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      <View className="flex-row gap-3 rounded-xl bg-surface p-4">
        <Icon name="bell" size={20} color="accent" />
        <View className="flex-1 gap-1">
          <Text variant="headline">Push notifications arrive in Phase 6</Text>
          <Text variant="footnote" tone="secondary">
            These preferences are saved now and will apply once notifications are connected.
            Incoming calls will use the system call screen.
          </Text>
        </View>
      </View>

      <ListSection title="Messages">
        <ListRow
          title="Direct Messages"
          accessory={{
            type: 'switch',
            value: p.messageNotifications,
            onValueChange: (v) => p.set('messageNotifications', v),
          }}
        />
        <ListRow
          title="Groups"
          accessory={{
            type: 'switch',
            value: p.groupNotifications,
            onValueChange: (v) => p.set('groupNotifications', v),
          }}
        />
      </ListSection>

      <ListSection
        title="Show Previews"
        footer="Choose when message text appears in notifications."
      >
        {PREVIEW.map((o) => (
          <ListRow
            key={o.value}
            title={o.label}
            accessory={{ type: 'check', checked: p.notificationPreview === o.value }}
            onPress={() => p.set('notificationPreview', o.value)}
          />
        ))}
      </ListSection>

      <ListSection title="Calls">
        <ListRow
          title="Incoming Calls"
          accessory={{
            type: 'switch',
            value: p.callNotifications,
            onValueChange: (v) => p.set('callNotifications', v),
          }}
        />
      </ListSection>

      <ListSection title="In-App">
        <ListRow
          title="Sounds"
          accessory={{
            type: 'switch',
            value: p.inAppSounds,
            onValueChange: (v) => p.set('inAppSounds', v),
          }}
        />
      </ListSection>
    </ScrollView>
  );
}
