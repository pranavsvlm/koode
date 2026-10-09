import type { Device } from '@koode/shared';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { ListRow, ListSection, SkeletonList, Text, useDialog, useToast } from '@/components/ui';
import { authClient } from '@/features/auth';
import { authErrorMessage } from '@/features/auth/errors';
import { formatConversationTime } from '@/lib/format';
import { useSession } from '@/stores/session';

function seen(d: Device): string {
  if (d.current) return 'This device';
  return d.lastSeenAt ? `Last active ${formatConversationTime(d.lastSeenAt)}` : 'Never active';
}

export default function DevicesScreen() {
  const toast = useToast();
  const dialog = useDialog();
  const signOut = useSession((s) => s.signOut);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setDevices(await authClient.devices());
    } catch (e) {
      toast.show({ title: 'Couldn’t load devices', message: authErrorMessage(e), tone: 'error' });
      setDevices((current) => current ?? []);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    authClient.devices().then(
      (list) => !cancelled && setDevices(list),
      () => !cancelled && setDevices([]),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (d: Device) => {
    const ok = await dialog.confirm({
      title: d.current ? 'Sign out of this device?' : `Remove “${d.name}”?`,
      message: d.current
        ? 'You’ll need your recovery key to sign back in on this phone.'
        : 'It will be signed out immediately and can’t sign back in without your recovery key.',
      confirmLabel: d.current ? 'Sign Out' : 'Remove',
      destructive: true,
    });
    if (!ok) return;
    if (d.current) return signOut();
    try {
      await authClient.revokeDevice(d.id);
      toast.show({ title: `${d.name} removed`, tone: 'success' });
      await load();
    } catch (e) {
      toast.show({
        title: 'Couldn’t remove the device',
        message: authErrorMessage(e),
        tone: 'error',
      });
    }
  };

  const current = devices?.filter((d) => d.current) ?? [];
  const others = devices?.filter((d) => !d.current) ?? [];

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
      {devices === null ? (
        <SkeletonList rows={2} avatarSize={30} />
      ) : (
        <>
          <ListSection title="This device">
            {current.map((d) => (
              <ListRow key={d.id} icon="devices" title={d.name} subtitle={seen(d)} />
            ))}
          </ListSection>
          <ListSection
            title="Other devices"
            footer="If you don’t recognise a device, remove it and consider creating a new recovery key."
          >
            {others.length === 0 ? (
              <ListRow title="No other devices" />
            ) : (
              others.map((d) => (
                <ListRow
                  key={d.id}
                  icon="devices"
                  iconTint="text-secondary"
                  title={d.name}
                  subtitle={seen(d)}
                  accessory={{ type: 'value', value: 'Remove' }}
                  onPress={() => remove(d)}
                />
              ))
            )}
          </ListSection>
          <ListSection>
            <ListRow
              title="Sign Out of This Device"
              destructive
              onPress={() => current[0] && remove(current[0])}
            />
          </ListSection>
        </>
      )}
      <Text variant="footnote" tone="tertiary" className="px-4 text-center">
        Each device has its own key, stored only in that device’s secure storage.
      </Text>
    </ScrollView>
  );
}
