import { formatInviteCode, type CreatedInvite, type Invite } from '@koode/shared';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import {
  Button,
  EmptyState,
  ListRow,
  ListSection,
  SkeletonList,
  Text,
  useDialog,
  useToast,
} from '@/components/ui';
import { authClient } from '@/features/auth';
import { authErrorMessage } from '@/features/auth/errors';
import { shareInvite } from '@/features/auth/invites';

function expiresIn(ts: number): string {
  const days = Math.ceil((ts - Date.now()) / 86_400_000);
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`;
}

export default function InvitesScreen() {
  const toast = useToast();
  const dialog = useDialog();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [fresh, setFresh] = useState<CreatedInvite | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setInvites(await authClient.invites());
    } catch (e) {
      toast.show({ title: 'Couldn’t load invites', message: authErrorMessage(e), tone: 'error' });
      setInvites((current) => current ?? []);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    authClient.invites().then(
      (list) => !cancelled && setInvites(list),
      () => !cancelled && setInvites([]),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const invite = await authClient.createInvite();
      setFresh(invite);
      await load();
    } catch (e) {
      toast.show({
        title: 'Couldn’t create an invite',
        message: authErrorMessage(e),
        tone: 'error',
      });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (invite: Invite) => {
    const ok = await dialog.confirm({
      title: 'Cancel this invite?',
      message: 'The code will stop working immediately.',
      confirmLabel: 'Cancel Invite',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    try {
      await authClient.revokeInvite(invite.id);
      if (fresh?.id === invite.id) setFresh(null);
      await load();
    } catch (e) {
      toast.show({
        title: 'Couldn’t cancel the invite',
        message: authErrorMessage(e),
        tone: 'error',
      });
    }
  };

  return (
    <ScrollView
      className="bg-background"
      contentContainerClassName="gap-7 px-4 pb-16 pt-4"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      <Text variant="subhead" tone="secondary" className="px-1">
        Koode is invite-only. Each code works once, for one person, and expires after 7 days. Only
        share it with someone you know.
      </Text>

      {fresh ? (
        <View className="gap-3 rounded-xl bg-surface p-5">
          <Text variant="footnote" tone="secondary" className="text-center font-medium uppercase">
            New invite code
          </Text>
          <Text
            variant="title1"
            className="text-center"
            style={{ letterSpacing: 3, fontVariant: ['tabular-nums'] }}
            selectable
          >
            {formatInviteCode(fresh.code)}
          </Text>
          <Text variant="footnote" tone="tertiary" className="text-center">
            Shown only once. Share it now.
          </Text>
          <Button
            label="Share Invite"
            icon="share"
            fullWidth
            onPress={() => shareInvite(fresh.code)}
          />
        </View>
      ) : (
        <Button
          label="Create Invite"
          icon="person-add"
          loading={creating}
          fullWidth
          onPress={create}
        />
      )}

      {invites === null ? (
        <SkeletonList rows={3} avatarSize={0} />
      ) : invites.length === 0 ? (
        <EmptyState
          icon="person-add"
          title="No open invites"
          message="Invites you create appear here until they’re used or expire."
        />
      ) : (
        <ListSection
          title="Open invites"
          footer="Codes aren’t stored on the server, so they can’t be shown again."
        >
          {invites.map((invite) => (
            <ListRow
              key={invite.id}
              icon="link"
              title={`Created ${new Date(invite.createdAt).toLocaleDateString()}`}
              subtitle={expiresIn(invite.expiresAt)}
              accessory={{ type: 'value', value: 'Cancel' }}
              onPress={() => revoke(invite)}
            />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}
