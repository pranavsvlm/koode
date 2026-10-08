import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/cn';
import { useThemeColors } from '@/theme/ThemeProvider';
import type { ColorToken } from '@/theme/tokens';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Inset grouped section, iOS Settings style. Rows are separated by inset hairlines. */
export function ListSection({
  title,
  footer,
  children,
  className,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
  className?: string;
}) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View className={cn('gap-1.5', className)}>
      {title && (
        <Text
          variant="footnote"
          tone="secondary"
          className="ml-4 font-medium uppercase"
          accessibilityRole="header"
        >
          {title}
        </Text>
      )}
      <View className="overflow-hidden rounded-xl bg-surface">
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {row}
            {i < rows.length - 1 && <View className="ml-[60px] h-px bg-separator" />}
          </Fragment>
        ))}
      </View>
      {footer && (
        <Text variant="footnote" tone="tertiary" className="mx-4">
          {footer}
        </Text>
      )}
    </View>
  );
}

type RowAccessory =
  | { type: 'chevron'; value?: string }
  | { type: 'switch'; value: boolean; onValueChange: (v: boolean) => void }
  | { type: 'check'; checked: boolean }
  | { type: 'value'; value: string }
  | { type: 'none' };

export type ListRowProps = {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** Background token of the rounded icon tile. */
  iconTint?: ColorToken;
  leading?: ReactNode;
  accessory?: RowAccessory;
  destructive?: boolean;
  onPress?: () => void;
};

export function ListRow({
  title,
  subtitle,
  icon,
  iconTint = 'accent',
  leading,
  accessory = { type: 'none' },
  destructive,
  onPress,
}: ListRowProps) {
  const colors = useThemeColors();
  const isSwitch = accessory.type === 'switch';
  const interactive = !!onPress || isSwitch;

  const content = (
    <View className="min-h-[52px] flex-row items-center gap-3 px-4 py-2.5">
      {leading ??
        (icon && (
          <View
            className="h-[30px] w-[30px] items-center justify-center rounded-sm"
            style={{ backgroundColor: colors[iconTint] }}
          >
            <Icon name={icon} size={16} color="#FFFFFF" weight="semibold" />
          </View>
        ))}
      <View className="flex-1 gap-0.5">
        <Text variant="body" tone={destructive ? 'danger' : 'primary'}>
          {title}
        </Text>
        {subtitle && (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        )}
      </View>
      {accessory.type === 'chevron' && (
        <View className="flex-row items-center gap-1.5">
          {accessory.value && (
            <Text variant="body" tone="tertiary">
              {accessory.value}
            </Text>
          )}
          <Icon name="chevron-right" size={14} color="text-tertiary" weight="semibold" />
        </View>
      )}
      {accessory.type === 'value' && (
        <Text variant="body" tone="tertiary">
          {accessory.value}
        </Text>
      )}
      {accessory.type === 'check' && accessory.checked && (
        <Icon name="check" size={18} color="accent" weight="bold" />
      )}
      {isSwitch && (
        <Switch
          value={accessory.value}
          onValueChange={(v) => {
            haptics.selection();
            accessory.onValueChange(v);
          }}
          trackColor={{ true: colors.success, false: colors.fill }}
          accessibilityLabel={title}
        />
      )}
    </View>
  );

  if (!interactive || isSwitch) {
    return (
      // Switch rows: the Switch itself carries the label and role.
      <View
        accessible={!isSwitch}
        accessibilityLabel={isSwitch ? undefined : subtitle ? `${title}, ${subtitle}` : title}
      >
        {content}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        haptics.selection();
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityState={accessory.type === 'check' ? { selected: accessory.checked } : undefined}
      className="active:bg-fill"
    >
      {content}
    </Pressable>
  );
}
