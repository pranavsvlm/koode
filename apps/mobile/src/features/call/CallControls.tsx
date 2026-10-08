import { View } from 'react-native';
import { GlassSurface, Icon, PressableScale, Text, type IconName } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { callColors } from '@/theme/tokens';

export type CallControl = {
  key: string;
  icon: IconName;
  label: string;
  active?: boolean;
  onPress: () => void;
};

export function CallControlButton({
  icon,
  label,
  active,
  onPress,
  size = 60,
  tone = 'default',
}: Omit<CallControl, 'key'> & { size?: number; tone?: 'default' | 'end' | 'accept' }) {
  const bg =
    tone === 'end'
      ? callColors.decline
      : tone === 'accept'
        ? callColors.accept
        : active
          ? callColors.controlActive
          : callColors.control;
  const fg = active && tone === 'default' ? callColors.controlActiveIcon : '#FFFFFF';
  return (
    <View className="items-center gap-1.5">
      <PressableScale
        onPress={() => {
          if (tone === 'default') haptics.selection();
          else haptics.press();
          onPress();
        }}
        activeScale={0.9}
        accessibilityRole={tone === 'default' ? 'switch' : 'button'}
        accessibilityLabel={label}
        accessibilityState={tone === 'default' ? { checked: !!active } : undefined}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg }}
        className="items-center justify-center"
      >
        <Icon name={icon} size={size * 0.4} color={fg} />
      </PressableScale>
      <Text variant="caption" style={{ color: callColors.textSecondary }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Glass dock of call toggles with the end-call button. */
export function CallControls({ controls, onEnd }: { controls: CallControl[]; onEnd: () => void }) {
  return (
    <GlassSurface scheme="dark" style={{ borderRadius: 36, marginHorizontal: 16 }}>
      <View className="flex-row items-start justify-evenly px-2 pb-3 pt-4">
        {controls.map(({ key, ...c }) => (
          <CallControlButton key={key} {...c} />
        ))}
        <CallControlButton icon="end-call" label="End" tone="end" onPress={onEnd} />
      </View>
    </GlassSurface>
  );
}
