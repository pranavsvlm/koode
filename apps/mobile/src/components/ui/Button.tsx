import { ActivityIndicator, View } from 'react-native';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { useThemeColors } from '@/theme/ThemeProvider';
import type { ColorToken } from '@/theme/tokens';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'plain' | 'destructive';
type Size = 'md' | 'lg';

const CONTAINER: Record<Variant, string> = {
  primary: 'bg-accent',
  secondary: 'bg-fill',
  plain: 'bg-transparent',
  destructive: 'bg-danger/10',
};
const FOREGROUND: Record<Variant, ColorToken> = {
  primary: 'accent-foreground',
  secondary: 'text',
  plain: 'accent',
  destructive: 'danger',
};
const LABEL_TONE = {
  primary: 'inverse',
  secondary: 'primary',
  plain: 'accent',
  destructive: 'danger',
} as const;
const SIZE: Record<Size, string> = {
  md: 'h-11 px-4 rounded-md',
  lg: 'h-[54px] px-6 rounded-lg',
};

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  className?: string;
  accessibilityHint?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  className,
  accessibilityHint,
}: ButtonProps) {
  const colors = useThemeColors();
  const fg = FOREGROUND[variant];

  return (
    <PressableScale
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      className={cn(
        'flex-row items-center justify-center gap-2',
        SIZE[size],
        CONTAINER[variant],
        fullWidth && 'self-stretch',
        className,
      )}
    >
      {loading ? (
        <ActivityIndicator color={colors[fg]} />
      ) : (
        <View className="flex-row items-center gap-2">
          {icon && <Icon name={icon} size={18} color={fg} weight="semibold" />}
          <Text variant="headline" tone={LABEL_TONE[variant]}>
            {label}
          </Text>
        </View>
      )}
    </PressableScale>
  );
}
