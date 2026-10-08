import {
  accents,
  colorTokens,
  cssVariablesFor,
  hexToRgbChannels,
  palette,
  resolvePalette,
  type AccentName,
  type ColorToken,
} from '../tokens';

function luminance(hex: string): number {
  const [r, g, b] = hexToRgbChannels(hex)
    .split(' ')
    .map((c) => {
      const v = Number(c) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('hexToRgbChannels', () => {
  it('converts hex to space-separated channels', () => {
    expect(hexToRgbChannels('#3D6BFF')).toBe('61 107 255');
  });

  it('rejects invalid input', () => {
    expect(() => hexToRgbChannels('#FFF')).toThrow();
  });
});

describe('palette', () => {
  it('defines every token in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(Object.keys(palette[scheme]).sort()).toEqual([...colorTokens].sort());
      expect(Object.keys(cssVariablesFor(scheme))).toHaveLength(colorTokens.length);
    }
  });

  // WCAG 2.1: 4.5:1 for body text, 3:1 for large text and non-essential UI text.
  const pairs: [fg: ColorToken, bg: ColorToken, min: number][] = [
    ['text', 'background', 7],
    ['text', 'surface', 7],
    ['text-secondary', 'background', 4.5],
    ['text-secondary', 'surface', 4.5],
    ['text-tertiary', 'background', 3],
    ['text', 'fill', 7],
    ['text-secondary', 'fill', 3],
    ['accent', 'background', 3],
    ['accent-foreground', 'accent', 4.5],
    ['bubble-outgoing-text', 'bubble-outgoing', 4.5],
    ['bubble-incoming-text', 'bubble-incoming', 7],
  ];

  const cases = (['light', 'dark'] as const).flatMap((scheme) =>
    (Object.keys(accents) as AccentName[]).map((accent) => [scheme, accent] as const),
  );

  it.each(cases)('meets contrast targets in %s mode with the %s accent', (scheme, accent) => {
    const p = resolvePalette(scheme, accent);
    for (const [fg, bg, min] of pairs) {
      const ratio = contrast(p[fg], p[bg]);
      expect({ pair: `${fg} on ${bg}`, ok: ratio >= min, ratio: Number(ratio.toFixed(2)) }).toEqual(
        expect.objectContaining({ ok: true }),
      );
    }
  });
});
