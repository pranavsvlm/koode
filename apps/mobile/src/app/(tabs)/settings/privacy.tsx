import { ScrollView, View } from 'react-native';
import { Icon, ListRow, ListSection, Text, useToast } from '@/components/ui';
import { usePreferences, type LastSeenVisibility } from '@/stores/preferences';

const LAST_SEEN: { value: LastSeenVisibility; label: string }[] = [
  { value: 'contacts', label: 'My Contacts' },
  { value: 'nobody', label: 'Nobody' },
];

export default function PrivacyScreen() {
  const p = usePreferences();
  const toast = useToast();

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      {/* Honest status: do not claim E2EE until Phase 8 is verified. */}
      <View
        className="flex-row gap-3 rounded-xl bg-warning/15 p-4"
        accessible
        accessibilityLabel="Encryption status: end-to-end encryption is not enabled yet. Messages are encrypted in transit only. Avoid sensitive conversations for now."
      >
        <Icon name="lock" size={20} color="warning" />
        <View className="flex-1 gap-1">
          <Text variant="headline">End-to-end encryption is not on yet</Text>
          <Text variant="footnote" tone="secondary">
            Messages and calls are encrypted in transit (TLS) but the server can read them. Avoid
            sensitive conversations until end-to-end encryption ships.
          </Text>
        </View>
      </View>

      <ListSection
        title="Messages"
        footer="If you turn off read receipts, you won’t see other people’s either."
      >
        <ListRow
          title="Read Receipts"
          accessory={{
            type: 'switch',
            value: p.readReceipts,
            onValueChange: (v) => p.set('readReceipts', v),
          }}
        />
        <ListRow
          title="Typing Indicators"
          accessory={{
            type: 'switch',
            value: p.typingIndicators,
            onValueChange: (v) => p.set('typingIndicators', v),
          }}
        />
      </ListSection>

      <ListSection title="Who can see when I was last online">
        {LAST_SEEN.map((o) => (
          <ListRow
            key={o.value}
            title={o.label}
            accessory={{ type: 'check', checked: p.lastSeen === o.value }}
            onPress={() => p.set('lastSeen', o.value)}
          />
        ))}
      </ListSection>

      <ListSection title="Security" footer="Require Face ID or your passcode to open Koode.">
        <ListRow
          icon="face-id"
          iconTint="success"
          title="Screen Lock"
          accessory={{
            type: 'switch',
            value: p.screenLock,
            onValueChange: (v) => p.set('screenLock', v),
          }}
        />
        <ListRow
          icon="devices"
          title="Linked Devices"
          accessory={{ type: 'chevron', value: '1' }}
          onPress={() => toast.show({ title: 'Device management arrives in Phase 3' })}
        />
        <ListRow
          icon="key"
          iconTint="warning"
          title="Recovery Key"
          accessory={{ type: 'chevron' }}
          onPress={() => toast.show({ title: 'Recovery key management arrives in Phase 3' })}
        />
        <ListRow
          icon="hand"
          iconTint="danger"
          title="Blocked Contacts"
          accessory={{ type: 'chevron', value: 'None' }}
          onPress={() => toast.show({ title: 'You haven’t blocked anyone' })}
        />
      </ListSection>
    </ScrollView>
  );
}
