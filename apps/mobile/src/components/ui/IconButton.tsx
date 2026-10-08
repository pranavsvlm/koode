import type { ColorValue } from 'react-native';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import type { ColorToken } from '@/theme/tokens';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';

export type IconButtonProps = {
  icon: IconName;
  /** Required: icon-only controls must be named for screen readers. */
  accessibilityLabel: string;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  color?: ColorToken | ColorValue;
  /** Tailwind classes for the circular background, e.g. "bg-fill". */
  className?: string;
  disabled?: boolean;
  selected?: boolean;
};

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 44,
  iconSize = 20,
  color = 'accent',
  className,
  disabled,
  selected,
}: IconButtonProps) {
  return (
    <PressableScale
      onPress={() => {
        haptics.tap();
        onPress?.();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      activeScale={0.9}
      className={cn('items-center justify-center rounded-full', className)}
      style={{ width: size, height: size }}
    >
      <Icon name={icon} size={iconSize} color={color} weight="semibold" />
    </PressableScale>
  );
}
