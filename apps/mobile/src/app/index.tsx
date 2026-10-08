import { Pressable, View } from 'react-native';
import { Screen, Text } from '@/components/ui';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { useServerHealth, type ServerHealth } from '@/lib/useServerHealth';
import { usePreferences, type AppearancePreference } from '@/stores/preferences';

/**
 * Phase 1 foundation screen: proves routing, theming, persisted preferences
 * and API connectivity end to end. Replaced by onboarding in Phase 2.
 */
export default function FoundationScreen() {
  const { health, recheck } = useServerHealth();

  return (
    <Screen className="px-6">
      <View className="flex-1 justify-center gap-2">
        <Text variant="large-title">Koode</Text>
        <Text variant="body" tone="secondary">
          Private messaging and calls for the people who matter.
        </Text>
      </View>

      <View className="gap-6 pb-6">
        <HealthRow health={health} onRetry={recheck} />
        <AppearancePicker />
      </View>
    </Screen>
  );
}

function HealthRow({ health, onRetry }: { health: ServerHealth; onRetry: () => void }) {
  const dot =
    health.state === 'online'
      ? 'bg-success'
      : health.state === 'offline'
        ? 'bg-danger'
        : 'bg-warning';
  const label =
    health.state === 'online'
      ? `Server online · ${health.environment}`
      : health.state === 'offline'
        ? 'Server unreachable'
        : 'Checking server…';

  return (
    <Pressable
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Double tap to check again.`}
      className="flex-row items-center gap-3 rounded-lg bg-surface px-4 py-3 active:opacity-70"
    >
      <View className={cn('h-2.5 w-2.5 rounded-full', dot)} />
      <View className="flex-1">
        <Text variant="subhead">{label}</Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {env.apiUrl}
        </Text>
      </View>
    </Pressable>
  );
}

const APPEARANCE_OPTIONS: { value: AppearancePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function AppearancePicker() {
  const appearance = usePreferences((s) => s.appearance);
  const setAppearance = usePreferences((s) => s.setAppearance);

  return (
    <View accessibilityRole="radiogroup" className="flex-row rounded-lg bg-surface p-1">
      {APPEARANCE_OPTIONS.map((option) => {
        const selected = option.value === appearance;
        return (
          <Pressable
            key={option.value}
            onPress={() => setAppearance(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            className={cn('flex-1 items-center rounded-md py-2', selected && 'bg-surface-raised')}
          >
            <Text
              variant="footnote"
              tone={selected ? 'primary' : 'secondary'}
              className="font-semibold"
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
