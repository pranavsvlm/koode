import Constants from 'expo-constants';
import { Linking, ScrollView } from 'react-native';
import { ListRow, ListSection } from '@/components/ui';

/** Where Koode's source is published (AGPL-3.0 requires offering it to users). */
export const sourceCodeUrl =
  (Constants.expoConfig?.extra?.sourceCodeUrl as string | undefined) ?? null;

const COMPONENTS: { name: string; license: string; note?: string }[] = [
  {
    name: 'libsignal (Signal Messenger)',
    license: 'AGPL-3.0',
    note: 'End-to-end encryption. Because of it, Koode’s own source is offered to you.',
  },
  { name: 'LiveKit client SDKs and WebRTC', license: 'Apache-2.0 / BSD-3-Clause' },
  { name: 'React Native', license: 'MIT' },
  { name: 'Expo SDK', license: 'MIT' },
  { name: 'Zustand, Zod, NativeWind, Reanimated', license: 'MIT' },
];

export default function LicensesScreen() {
  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      <ListSection
        title="Source code"
        footer="Koode uses libsignal, licensed under the GNU Affero General Public License v3, so Koode’s source code is offered to everyone who uses it."
      >
        <ListRow
          icon="link"
          title="Koode’s Source Code"
          subtitle={sourceCodeUrl ?? 'Not published yet'}
          accessory={sourceCodeUrl ? { type: 'chevron' } : { type: 'none' }}
          onPress={sourceCodeUrl ? () => void Linking.openURL(sourceCodeUrl) : undefined}
        />
      </ListSection>
      <ListSection title="Built with">
        {COMPONENTS.map((c) => (
          <ListRow
            key={c.name}
            title={c.name}
            subtitle={c.note ? `${c.license} · ${c.note}` : c.license}
          />
        ))}
      </ListSection>
    </ScrollView>
  );
}
