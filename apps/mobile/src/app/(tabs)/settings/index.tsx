import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { Avatar, Icon, ListRow, ListSection, Text, useDialog } from '@/components/ui';
import { useDevSettings } from '@/dev/settings';
import { env } from '@/lib/env';
import { useServerHealth } from '@/lib/useServerHealth';
import { useChat } from '@/stores/chat';
import { usePreferences } from '@/stores/preferences';
import { useSession } from '@/stores/session';
import { accents } from '@/theme/tokens';

export default function SettingsScreen() {
  const profile = useSession((s) => s.user);
  const signOut = useSession((s) => s.signOut);
  const appearance = usePreferences((s) => s.appearance);
  const accent = usePreferences((s) => s.accent);
  const dialog = useDialog();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="bg-background"
      contentContainerClassName="gap-7 px-4 pb-28 pt-2"
    >
      <Pressable
        onPress={() => router.push('/settings/profile')}
        accessibilityRole="button"
        accessibilityLabel={`${profile?.displayName}, @${profile?.username}. Edit profile`}
        className="flex-row items-center gap-4 rounded-xl bg-surface p-4 active:opacity-80"
      >
        <Avatar id={profile?.username ?? 'me'} name={profile?.displayName ?? 'You'} size={64} />
        <View className="flex-1 gap-0.5">
          <Text variant="title3">{profile?.displayName}</Text>
          <Text variant="subhead" tone="secondary">
            @{profile?.username}
          </Text>
        </View>
        <Icon name="chevron-right" size={14} color="text-tertiary" weight="semibold" />
      </Pressable>

      <ListSection>
        <ListRow
          icon="shield"
          iconTint="success"
          title="Privacy & Security"
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/privacy')}
        />
        <ListRow
          icon="bell"
          iconTint="danger"
          title="Notifications"
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/notifications')}
        />
        <ListRow
          icon="palette"
          title="Appearance"
          accessory={{
            type: 'chevron',
            value: `${appearance[0]!.toUpperCase()}${appearance.slice(1)} · ${accents[accent].label}`,
          }}
          onPress={() => router.push('/settings/appearance')}
        />
      </ListSection>

      <ListSection footer="Koode is invite-only. Each invite works once.">
        <ListRow
          icon="person-add"
          iconTint="success"
          title="Invite Family & Friends"
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/invites')}
        />
      </ListSection>

      <ListSection footer="Koode has no ads, no analytics and no third-party trackers.">
        <ListRow
          icon="info"
          iconTint="text-secondary"
          title="About Koode"
          accessory={{ type: 'value', value: `v${Constants.expoConfig?.version ?? '0.0.0'}` }}
        />
        <ListRow
          icon="document"
          iconTint="text-secondary"
          title="Source Code & Licences"
          accessory={{ type: 'chevron' }}
          onPress={() => router.push('/settings/licenses')}
        />
      </ListSection>

      {__DEV__ && <DeveloperSection />}

      <ListSection>
        <ListRow
          title="Sign Out"
          destructive
          onPress={async () => {
            const ok = await dialog.confirm({
              title: 'Sign out?',
              message:
                'This removes this phone from your account. You’ll need your recovery key to sign back in.',
              confirmLabel: 'Sign Out',
              destructive: true,
            });
            if (ok) await signOut();
          }}
        />
      </ListSection>
    </ScrollView>
  );
}

function DeveloperSection() {
  const { health, recheck } = useServerHealth();
  const dev = useDevSettings();
  const healthText =
    health.state === 'online'
      ? `Online · ${health.environment}`
      : health.state === 'offline'
        ? 'Unreachable'
        : 'Checking…';

  return (
    <ListSection
      title="Developer"
      footer={`API: ${env.apiUrl}. Accounts and messages are real (local server). Calls, reactions and media are still simulated. Empty data and simulated replies apply to sample data only.`}
    >
      <ListRow
        icon="server"
        iconTint={
          health.state === 'online' ? 'success' : health.state === 'offline' ? 'danger' : 'warning'
        }
        title="Server"
        subtitle={healthText}
        accessory={{ type: 'chevron', value: 'Check' }}
        onPress={recheck}
      />
      <ListRow
        icon="clock"
        iconTint="warning"
        title="Slow loading"
        subtitle="Show skeletons on next reload"
        accessory={{
          type: 'switch',
          value: dev.slowLoading,
          onValueChange: (v) => dev.set({ slowLoading: v }),
        }}
      />
      <ListRow
        icon="sparkles"
        iconTint="text-secondary"
        title="Empty data"
        subtitle="Review empty states on next reload"
        accessory={{
          type: 'switch',
          value: dev.emptyData,
          onValueChange: (v) => dev.set({ emptyData: v }),
        }}
      />
      <ListRow
        icon="message"
        title="Simulated replies"
        subtitle="Contacts type and reply to you"
        accessory={{
          type: 'switch',
          value: dev.simulateReplies,
          onValueChange: (v) => dev.set({ simulateReplies: v }),
        }}
      />
      <ListRow
        icon="download"
        iconTint="success"
        title="Sample data"
        subtitle="Show built-in conversations instead of your real ones"
        accessory={{
          type: 'switch',
          value: dev.sampleData,
          onValueChange: (v) => {
            dev.set({ sampleData: v });
            void useChat
              .getState()
              .unload()
              .then(() => useChat.getState().load(useSession.getState().user?.id));
          },
        }}
      />
      <ListRow
        icon="phone"
        iconTint="success"
        title="Simulate incoming voice call"
        onPress={() =>
          router.push({
            pathname: '/incoming-call',
            params: { contactId: 'grandma', kind: 'voice' },
          })
        }
      />
      <ListRow
        icon="video"
        iconTint="success"
        title="Simulate incoming video call"
        onPress={() =>
          router.push({ pathname: '/incoming-call', params: { contactId: 'maya', kind: 'video' } })
        }
      />
    </ListSection>
  );
}
