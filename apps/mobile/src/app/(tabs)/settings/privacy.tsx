import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { Icon, ListRow, ListSection, Text, useDialog, useToast } from '@/components/ui';
import { usePreferences, type LastSeenVisibility } from '@/stores/preferences';
import { useSession } from '@/stores/session';

const LAST_SEEN: { value: LastSeenVisibility; label: string }[] = [
  { value: 'contacts', label: 'My Contacts' },
  { value: 'nobody', label: 'Nobody' },
];

export default function PrivacyScreen() {
  const p = usePreferences();
  const toast = useToast();
  const dialog = useDialog();
  const deleteAccount = useSession((s) => s.deleteAccount);

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      {/* Honest status: encrypted, but not independently reviewed yet. */}
      <View
        className="flex-row gap-3 rounded-xl bg-warning/15 p-4"
        accessible
        accessibilityLabel="Encryption status: end-to-end encrypted with the Signal Protocol, not yet independently reviewed. Avoid highly sensitive conversations for now."
      >
        <Icon name="lock" size={20} color="warning" />
        <View className="flex-1 gap-1">
          <Text variant="headline">End-to-end encrypted, pending review</Text>
          <Text variant="footnote" tone="secondary">
            Messages, photos, files, reactions and calls are encrypted on your device with the
            Signal Protocol; Koode’s server can’t read them. It still sees who you talk to and when.
            This hasn’t been independently reviewed yet, so avoid highly sensitive conversations for
            now.
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
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/devices')}
        />
        <ListRow
          icon="key"
          iconTint="warning"
          title="Recovery Key"
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/recovery-key')}
        />
        <ListRow
          icon="hand"
          iconTint="danger"
          title="Blocked Contacts"
          accessory={{ type: 'chevron', value: 'None' }}
          onPress={() => toast.show({ title: 'You haven’t blocked anyone' })}
        />
      </ListSection>

      <ListSection footer="Deletes your account, signs out all your devices, and deletes every message and file you sent, for everyone. This can’t be undone.">
        <ListRow
          title="Delete Account"
          destructive
          onPress={async () => {
            const ok = await dialog.confirm({
              title: 'Delete your account?',
              message:
                'Your profile, devices and keys are removed, and everything you sent is deleted for everyone. You can’t undo this.',
              confirmLabel: 'Delete Account',
              destructive: true,
            });
            if (!ok) return;
            try {
              await deleteAccount();
            } catch {
              toast.show({ title: 'Couldn’t delete your account. Try again.', tone: 'error' });
            }
          }}
        />
      </ListSection>
    </ScrollView>
  );
}
