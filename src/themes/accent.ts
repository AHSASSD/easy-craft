import type { Preferences } from '../core/contracts';

export const validAccent = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function rgb(color: string) {
  return [1, 3, 5].map((offset) =>
    parseInt(color.slice(offset, offset + 2), 16),
  );
}
function mix(source: string, target: string, amount: number): string {
  const from = rgb(source),
    to = rgb(target);
  return (
    '#' +
    from
      .map((value, index) =>
        Math.round(value + (to[index] - value) * amount)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const first = luminance(a),
    second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
function readable(
  color: string,
  backgrounds: string[],
  target: string,
): string {
  const passes = (candidate: string) =>
    backgrounds.every((background) => contrast(candidate, background) >= 4.6);
  if (passes(color)) return color;
  let low = 0,
    high = 1;
  for (let step = 0; step < 20; step++) {
    const middle = (low + high) / 2;
    if (passes(mix(color, target, middle))) high = middle;
    else low = middle;
  }
  return mix(color, target, high);
}
export function accentStyle(
  color: string | undefined,
  theme: Preferences['theme'],
): Record<`--${string}`, string> {
  if (color === undefined) return {};
  if (!validAccent(color)) throw new Error('强调色须为 #RRGGBB');
  const light = theme === 'grass';
  const panel = light ? '#f9fbfa' : '#1c2420';
  const tinted = mix(panel, color, light ? 0.1 : 0.14);
  const surfaces = light
    ? ['#edf1ef', '#ffffff', panel, '#eaf2e8', tinted]
    : ['#171d1b', '#222b26', panel, '#2d3931', tinted];
  const foreground = readable(color, surfaces, light ? '#000000' : '#ffffff');
  const action = readable(color, ['#ffffff'], '#000000');
  return {
    '--accent': foreground,
    '--accent-dark': tinted,
    '--action': action,
    '--action-top': mix(action, '#000000', 0.04),
    '--action-bottom': mix(action, '#000000', 0.16),
    '--nav-action-bottom': action,
    '--action-border': action,
  };
}
