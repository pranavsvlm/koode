import type { Config } from 'tailwindcss';
import { colorTokens, cssVariablesFor, radius, typeScale } from './src/theme/tokens';

const colors = Object.fromEntries(
  colorTokens.map((t) => [t, `rgb(var(--color-${t}) / <alpha-value>)`]),
);

type FontSizeEntry = [string, { lineHeight: string; letterSpacing: string; fontWeight: string }];

const fontSize = Object.fromEntries(
  Object.entries(typeScale).map(([name, t]): [string, FontSizeEntry] => [
    name,
    [
      `${t.fontSize}px`,
      {
        lineHeight: `${t.lineHeight}px`,
        letterSpacing: `${t.letterSpacing}px`,
        fontWeight: t.fontWeight,
      },
    ],
  ]),
);

export default {
  content: ['./src/**/*.{ts,tsx}'],
  // nativewind/preset ships CommonJS without module typings.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors,
      fontSize,
      borderRadius: Object.fromEntries(Object.entries(radius).map(([k, v]) => [k, `${v}px`])),
    },
  },
  plugins: [
    // Light-scheme defaults so classes resolve even outside <ThemeProvider>.
    ({ addBase }: { addBase: (styles: Record<string, Record<string, string>>) => void }) =>
      addBase({ ':root': cssVariablesFor('light') }),
  ],
} satisfies Config;
