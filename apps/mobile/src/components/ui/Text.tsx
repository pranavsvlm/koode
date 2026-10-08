import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { cn } from '@/lib/cn';
import type { TypeVariant } from '@/theme/tokens';

// Literal class strings so Tailwind's content scanner generates every one.
const VARIANT_CLASS: Record<TypeVariant, string> = {
  'large-title': 'text-large-title',
  title1: 'text-title1',
  title2: 'text-title2',
  title3: 'text-title3',
  headline: 'text-headline',
  body: 'text-body',
  callout: 'text-callout',
  subhead: 'text-subhead',
  footnote: 'text-footnote',
  caption: 'text-caption',
};

const TONE_CLASS = {
  primary: 'text-text',
  secondary: 'text-text-secondary',
  tertiary: 'text-text-tertiary',
  accent: 'text-accent',
  danger: 'text-danger',
  inverse: 'text-accent-foreground',
} as const;
export type TextTone = keyof typeof TONE_CLASS;

const HEADING_VARIANTS = new Set<TypeVariant>(['large-title', 'title1', 'title2', 'title3']);

export type TextProps = RNTextProps & {
  variant?: TypeVariant;
  tone?: TextTone;
  className?: string;
};

export function Text({ variant = 'body', tone = 'primary', className, ...props }: TextProps) {
  return (
    <RNText
      accessibilityRole={HEADING_VARIANTS.has(variant) ? 'header' : undefined}
      {...props}
      className={cn(VARIANT_CLASS[variant], TONE_CLASS[tone], className)}
    />
  );
}
