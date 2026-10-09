import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { Button, Icon, ListRow, ListSection, Text } from '@/components/ui';
import { notificationsAllowed, requestNotificationPermission } from '@/features/notifications';
import { usePreferences } from '@/stores/preferences';

export default function NotificationsScreen() {
  const p = usePreferences();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  // Re-check when returning from the system Settings app.
  useFocusEffect(
    useCallback(() => {
      void notificationsAllowed().then(setAllowed);
    }, []),
  );

  const turnOn = async () => {
    // iOS shows its prompt only once; after that only Settings can change it.
    if (!p.notificationsAsked) setAllowed(await requestNotificationPermission());
    else void Linking.openSettings();
  };

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      {allowed === false && (
        <View className="gap-3 rounded-xl bg-surface p-4">
          <View className="flex-row gap-3">
            <Icon name="bell" size={20} color="accent" />
            <View className="flex-1 gap-1">
              <Text variant="headline">Notifications are off</Text>
              <Text variant="footnote" tone="secondary">
                You won’t hear about new messages or missed calls while Koode is closed. Incoming
                calls still ring on iPhone.
              </Text>
            </View>
          </View>
          <Button
            label={p.notificationsAsked ? 'Open Settings' : 'Turn On Notifications'}
            size="md"
            onPress={() => void turnOn()}
          />
        </View>
      )}

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
        title="Privacy"
        footer="Messages are end-to-end encrypted, so Koode’s server can’t read them and notifications only say who wrote: never what they said. Nothing readable passes through Apple’s or Google’s push service."
      >
        <ListRow icon="lock" title="Notifications show the sender only" />
      </ListSection>

      <ListSection
        title="Calls"
        footer="On iPhone, incoming calls use the system call screen, even when the phone is locked."
      >
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
