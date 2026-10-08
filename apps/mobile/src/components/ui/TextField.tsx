import { forwardRef, useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { cn } from '@/lib/cn';
import { useThemeColors } from '@/theme/ThemeProvider';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type TextFieldProps = TextInputProps & {
  label?: string;
  hint?: string;
  error?: string;
  icon?: IconName;
  /** Static text shown before the input, e.g. "@" for usernames. */
  prefix?: string;
  className?: string;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, hint, error, icon, prefix, className, onFocus, onBlur, ...props },
  ref,
) {
  const colors = useThemeColors();
  const [focused, setFocused] = useState(false);

  return (
    <View className={cn('gap-1.5', className)}>
      {label && (
        <Text variant="footnote" tone="secondary" className="ml-1 font-medium">
          {label}
        </Text>
      )}
      <View
        className={cn(
          'min-h-[50px] flex-row items-center gap-2.5 rounded-lg bg-fill px-4',
          focused && 'bg-surface-raised',
          error && 'bg-danger/10',
        )}
        style={focused ? { borderWidth: 1.5, borderColor: colors.accent } : undefined}
      >
        {icon && <Icon name={icon} size={18} color="text-tertiary" />}
        {prefix && (
          <Text variant="body" tone="tertiary">
            {prefix}
          </Text>
        )}
        <TextInput
          ref={ref}
          placeholderTextColor={colors['text-tertiary']}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          accessibilityLabel={label ?? props.placeholder}
          accessibilityHint={error ?? hint}
          {...props}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          className="flex-1 py-3 text-body text-text"
        />
      </View>
      {(error || hint) && (
        <Text variant="footnote" tone={error ? 'danger' : 'tertiary'} className="ml-1">
          {error ?? hint}
        </Text>
      )}
    </View>
  );
});
