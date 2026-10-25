import { expect, test } from 'vitest';
import { accentStyle, validAccent } from '../src/themes/accent';

function luminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/../g)!
    .map((hex) => parseInt(hex, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels.reduce(
    (total, c, index) => total + c * [0.2126, 0.7152, 0.0722][index],
    0,
  );
}
function contrast(a: string, b: string): number {
  const pair = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (pair[0] + 0.05) / (pair[1] + 0.05);
}
test('arbitrary accent colors remain readable across both themes and white primary labels', () => {
  expect(contrast('#000000', '#ffffff')).toBe(21);
  expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
  for (const theme of ['grass', 'slate'] as const) {
    for (const r of [0, 64, 128, 192, 255])
      for (const g of [0, 64, 128, 192, 255])
        for (const b of [0, 64, 128, 192, 255]) {
          const color =
            '#' +
            [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
          const style = accentStyle(color, theme);
          for (const value of Object.values(style))
            expect(validAccent(value)).toBe(true);
          const backgrounds =
            theme === 'grass'
              ? ['#edf1ef', '#ffffff', '#f9fbfa', '#eaf2e8']
              : ['#171d1b', '#222b26', '#1c2420', '#2d3931'];
          backgrounds.push(style['--accent-dark']);
          for (const background of backgrounds)
            expect(
              contrast(style['--accent'], background),
              `${theme} ${color} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
          for (const key of [
            '--action',
            '--action-top',
            '--action-bottom',
            '--nav-action-bottom',
          ] as const)
            expect(
              contrast(style[key], '#ffffff'),
              `${color} ${key}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
  }
});
test('default restoration removes custom variables and invalid colors cannot become CSS', () => {
  expect(accentStyle(undefined, 'grass')).toEqual({});
  expect(validAccent('#Ab12EF')).toBe(true);
  for (const value of [
    'red',
    '#fff',
    '#11223344',
    'url(https://example.com/a)',
    '#000000; color:red',
    '',
    null,
    123,
  ]) {
    expect(validAccent(value)).toBe(false);
    expect(() => accentStyle(value as string, 'slate')).toThrow('强调色');
  }
});
