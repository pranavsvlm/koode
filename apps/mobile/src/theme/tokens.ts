/**
 * Design tokens — the single source of truth for colour, type, radius and
 * motion. Tailwind (tailwind.config.ts) and runtime code both read from here.
 *
 * Colours are semantic: components ask for `text-secondary` or `bg-surface`,
 * never a raw hex, so light and dark themes switch by swapping variables.
 */

export type ColorScheme = 'light' | 'dark';

export const colorTokens = [
  'background',
  'surface',
  'surface-raised',
  'fill',
  'text',
  'text-secondary',
  'text-tertiary',
  'separator',
  'accent',
  'accent-foreground',
  'bubble-outgoing',
  'bubble-outgoing-text',
  'bubble-incoming',
  'bubble-incoming-text',
  'success',
  'warning',
  'danger',
  'scrim',
] as const;
export type ColorToken = (typeof colorTokens)[number];
export type Palette = Record<ColorToken, string>;

export const palette: Record<ColorScheme, Palette> = {
  light: {
    background: '#FFFFFF',
    surface: '#F5F6F8',
    'surface-raised': '#FFFFFF',
    fill: '#ECEEF2',
    text: '#0B0C10',
    'text-secondary': '#5C6270',
    'text-tertiary': '#868B96',
    separator: '#E4E6EB',
    accent: '#3563F0',
    'accent-foreground': '#FFFFFF',
    'bubble-outgoing': '#3563F0',
    'bubble-outgoing-text': '#FFFFFF',
    'bubble-incoming': '#EEF0F3',
    'bubble-incoming-text': '#0B0C10',
    success: '#1A9A5C',
    warning: '#E8A317',
    danger: '#E5484D',
    scrim: '#0B0C10',
  },
  dark: {
    background: '#0B0C10',
    surface: '#15171C',
    'surface-raised': '#1D2026',
    fill: '#24272E',
    text: '#F3F4F6',
    'text-secondary': '#A1A7B3',
    'text-tertiary': '#6B7280',
    separator: '#262A31',
    accent: '#3D68F5',
    'accent-foreground': '#FFFFFF',
    'bubble-outgoing': '#3D68F5',
    'bubble-outgoing-text': '#FFFFFF',
    'bubble-incoming': '#1D2026',
    'bubble-incoming-text': '#F3F4F6',
    success: '#30C77B',
    warning: '#F5B83D',
    danger: '#FF6369',
    scrim: '#000000',
  },
};

/**
 * User-selectable accents. Each value is used both as a fill under white text
 * (needs 4.5:1) and as text/icon colour on the background (needs 3:1);
 * tokens.test.ts enforces both.
 */
export const accents = {
  blue: { label: 'Blue', light: '#3563F0', dark: '#3D68F5' },
  indigo: { label: 'Indigo', light: '#5B4FE0', dark: '#6A5CF2' },
  teal: { label: 'Teal', light: '#0E7C77', dark: '#0E7C77' },
  rose: { label: 'Rose', light: '#C92A65', dark: '#D6336C' },
  graphite: { label: 'Graphite', light: '#4A5160', dark: '#646B7A' },
} as const;
export type AccentName = keyof typeof accents;

/** The full palette for a scheme with the chosen accent applied. */
export function resolvePalette(scheme: ColorScheme, accent: AccentName = 'blue'): Palette {
  const value = accents[accent][scheme];
  return { ...palette[scheme], accent: value, 'bubble-outgoing': value };
}

/**
 * Call screens are always dark (like FaceTime), whatever the app theme, so
 * video and caller artwork read consistently.
 */
export const callColors = {
  background: '#06070A',
  text: '#FFFFFF',
  textSecondary: 'rgba(255,255,255,0.72)',
  control: 'rgba(255,255,255,0.16)',
  controlActive: '#FFFFFF',
  controlActiveIcon: '#06070A',
  accept: '#22C55E',
  decline: '#EF4444',
} as const;

/** Apple HIG-aligned type ramp. */
export const typeScale = {
  'large-title': { fontSize: 34, lineHeight: 41, letterSpacing: 0.4, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, letterSpacing: 0.38, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, letterSpacing: -0.26, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, letterSpacing: -0.45, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, letterSpacing: -0.43, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, letterSpacing: -0.43, fontWeight: '400' },
  callout: { fontSize: 16, lineHeight: 21, letterSpacing: -0.31, fontWeight: '400' },
  subhead: { fontSize: 15, lineHeight: 20, letterSpacing: -0.23, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, letterSpacing: -0.08, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, letterSpacing: 0, fontWeight: '400' },
} as const;
export type TypeVariant = keyof typeof typeScale;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  bubble: 20,
  full: 9999,
} as const;

/** Spring presets for Reanimated `withSpring`. Keep motion subtle. */
export const springs = {
  snappy: { damping: 20, stiffness: 300, mass: 0.8 },
  gentle: { damping: 18, stiffness: 180, mass: 1 },
  bouncy: { damping: 12, stiffness: 220, mass: 0.9 },
} as const;

/**
 * Deterministic avatar gradients. Muted, two-stop pairs that read well under
 * white initials in both themes.
 */
export const avatarGradients = [
  ['#6E8BFF', '#3B5BDB'],
  ['#F58FA8', '#C2255C'],
  ['#5FD3B5', '#0C8A6E'],
  ['#FFB86B', '#E8590C'],
  ['#A78BFA', '#6741D9'],
  ['#74C0FC', '#1971C2'],
  ['#F783AC', '#A61E4D'],
  ['#8CE99A', '#2B8A3E'],
] as const;

/** "#RRGGBB" → "R G B", the channel format Tailwind's <alpha-value> needs. */
export function hexToRgbChannels(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Invalid hex colour: ${hex}`);
  const n = parseInt(match[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** CSS variable map for a palette, e.g. { '--color-accent': '61 107 255' }. */
export function cssVariablesFor(
  scheme: ColorScheme,
  accent: AccentName = 'blue',
): Record<`--color-${ColorToken}`, string> {
  const p = resolvePalette(scheme, accent);
  const entries = colorTokens.map((t) => [`--color-${t}`, hexToRgbChannels(p[t])]);
  return Object.fromEntries(entries) as Record<`--color-${ColorToken}`, string>;
}
