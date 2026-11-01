import { test, expect } from 'vitest';
import { parseLocalPlugin } from '../src/core/local-plugins';
const plugin = {
  schemaVersion: 1,
  id: 'community.compact',
  name: 'Compact',
  version: '1.0.0',
  type: 'layout',
  settings: { layout: 'compact', sidebarWidth: 260 },
};
test('local plugins accept bounded declarative configuration and reject code or invalid settings', () => {
  expect(parseLocalPlugin(JSON.stringify(plugin)).settings.layout).toBe(
    'compact',
  );
  for (const value of [
    { ...plugin, script: 'alert(1)' },
    { ...plugin, id: 'official.layout' },
    { ...plugin, settings: { sidebarWidth: 9999 } },
    { ...plugin, type: 'javascript' },
    { ...plugin, settings: { accentColor: 'red' } },
    { ...plugin, settings: { __proto__: null, javaPath: 'evil' } },
  ])
    expect(() => parseLocalPlugin(JSON.stringify(value))).toThrow();
  expect(() => parseLocalPlugin(' '.repeat(131073))).toThrow();
  expect(() => parseLocalPlugin('{}')).toThrow();
});
