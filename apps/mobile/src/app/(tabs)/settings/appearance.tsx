import { Pressable, ScrollView, View } from 'react-native';
import { Icon, ListRow, ListSection, SegmentedControl, Text } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { usePreferences, type AppearancePreference, type ChatTextSize } from '@/stores/preferences';
import { useAppColorScheme } from '@/theme/ThemeProvider';
import { accents, type AccentName } from '@/theme/tokens';

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: AppearancePreference; label: string }[];

const SIZES: { value: ChatTextSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];
const SIZE_PX: Record<ChatTextSize, number> = { small: 15, default: 17, large: 20 };

export default function AppearanceScreen() {
  const p = usePreferences();
  const scheme = useAppColorScheme();

  return (
    <ScrollView className="bg-background" contentContainerClassName="gap-7 px-4 pb-16 pt-4">
      {/* Live preview */}
      <View
        className="gap-2 rounded-xl bg-surface p-4"
        accessibilityLabel="Chat preview"
        accessible
      >
        <View className="max-w-[78%] self-start rounded-bubble bg-bubble-incoming px-3.5 py-2">
          <Text
            tone="primary"
            style={{ fontSize: SIZE_PX[p.chatTextSize], lineHeight: SIZE_PX[p.chatTextSize] * 1.3 }}
          >
            Sunday dinner at ours? 🍝
          </Text>
        </View>
        <View className="max-w-[78%] self-end rounded-bubble bg-bubble-outgoing px-3.5 py-2">
          <Text
            tone="inverse"
            style={{ fontSize: SIZE_PX[p.chatTextSize], lineHeight: SIZE_PX[p.chatTextSize] * 1.3 }}
          >
            Wouldn’t miss it. I’ll bring dessert!
          </Text>
        </View>
      </View>

      <ListSection title="Theme">
        <View className="p-3">
          <SegmentedControl
            options={THEMES}
            value={p.appearance}
            onChange={(v) => p.set('appearance', v)}
            accessibilityLabel="Theme"
          />
        </View>
      </ListSection>

      <View className="gap-1.5">
        <Text variant="footnote" tone="secondary" className="ml-4 font-medium uppercase">
          Accent
        </Text>
        <View
          className="flex-row justify-between rounded-xl bg-surface px-5 py-4"
          accessibilityRole="radiogroup"
        >
          {(Object.keys(accents) as AccentName[]).map((name) => {
            const selected = p.accent === name;
            return (
              <Pressable
                key={name}
                onPress={() => {
                  haptics.selection();
                  p.set('accent', name);
                }}
                accessibilityRole="radio"
                accessibilityLabel={accents[name].label}
                accessibilityState={{ selected }}
                className="items-center gap-1.5"
              >
                <View
                  className={cn(
                    'h-11 w-11 items-center justify-center rounded-full',
                    selected && 'border-[3px] border-text/15',
                  )}
                  style={{ backgroundColor: accents[name][scheme] }}
                >
                  {selected && <Icon name="check" size={18} color="#FFFFFF" weight="bold" />}
                </View>
                <Text variant="caption" tone={selected ? 'primary' : 'secondary'}>
                  {accents[name].label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <ListSection
        title="Chat Text Size"
        footer="Koode also follows your system text size settings."
      >
        {SIZES.map((o) => (
          <ListRow
            key={o.value}
            title={o.label}
            accessory={{ type: 'check', checked: p.chatTextSize === o.value }}
            onPress={() => p.set('chatTextSize', o.value)}
          />
        ))}
      </ListSection>
    </ScrollView>
  );
}
