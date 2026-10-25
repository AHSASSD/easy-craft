import { expect, test } from 'vitest';
import {
  createInstances,
  createPreferences,
  createThemes,
  validInstances,
  validPreferences,
} from '../src/core/services';
import type { StorageAdapter } from '../src/core/persistence/store';
import { defaultNavigation } from '../src/core/navigation';
function memory(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
test('navigation persists independently while old preferences remain valid', () => {
  const storage = memory();
  const preferences = createPreferences(storage);
  expect(validPreferences(preferences.snapshot())).toBe(true);
  preferences.update({
    navigation: {
      ...defaultNavigation,
      section: 'download',
      downloadCategory: 'mod',
      instanceTabs: { instance: 'worlds' },
      scroll: { download: 70 },
      contentQueries: { 'instance:mods': 'fabric' },
      resourceKinds: { instance: 'shaderpacks' },
      datapackWorlds: { instance: '世界 A' },
    },
  });
  expect(createPreferences(storage).snapshot().navigation).toMatchObject({
    section: 'download',
    downloadCategory: 'mod',
    instanceTabs: { instance: 'worlds' },
    contentQueries: { 'instance:mods': 'fabric' },
    resourceKinds: { instance: 'shaderpacks' },
    datapackWorlds: { instance: '世界 A' },
  });
  expect(() =>
    preferences.update({
      navigation: { ...defaultNavigation, scroll: { bad: NaN } },
    }),
  ).toThrow();
  expect(
    validPreferences({
      ...preferences.snapshot(),
      navigation: { ...defaultNavigation, contentQueries: { bad: 1 } },
    }),
  ).toBe(false);
  expect(
    validPreferences({
      ...preferences.snapshot(),
      navigation: {
        ...defaultNavigation,
        datapackWorlds: { instance: '../other' },
      },
    }),
  ).toBe(false);
  expect(
    validPreferences({
      ...preferences.snapshot(),
      navigation: { ...defaultNavigation, resourceKinds: { bad: 'mods' } },
    }),
  ).toBe(false);
});
test('appearance preferences preserve old profiles and reject invalid persisted values', () => {
  const storage = memory();
  const preferences = createPreferences(storage);
  preferences.update({ theme: 'grass', sidebarWidth: 340 });
  expect(preferences.snapshot().backgroundShade).toBeUndefined();
  expect(preferences.snapshot().reduceMotion).toBeUndefined();
  preferences.update({ backgroundShade: 60, reduceMotion: true });
  expect(createPreferences(storage).snapshot()).toMatchObject({
    theme: 'grass',
    sidebarWidth: 340,
    backgroundShade: 60,
    reduceMotion: true,
  });
  for (const value of [NaN, Infinity, 19, 81, 35.5, '60', null]) {
    expect(
      validPreferences({ ...preferences.snapshot(), backgroundShade: value }),
    ).toBe(false);
  }
  expect(() => preferences.update({ backgroundShade: 90 })).toThrow();
  expect(createPreferences(storage).snapshot().backgroundShade).toBe(60);
  expect(
    validPreferences({ ...preferences.snapshot(), reduceMotion: 'yes' }),
  ).toBe(false);
});

test('preferences and instance edits persist across reload; duplicate versions have unique ids', async () => {
  const storage = memory();
  const prefs = createPreferences(storage);
  const instances = createInstances(prefs, storage);
  createThemes(prefs).activateTheme('grass');
  prefs.update({ sidebarWidth: 340 });
  instances.add('新世界', '1.21.1', 'vanilla');
  const item = instances.snapshot().at(-1)!;
  await instances.select(item.id);
  instances.rename(item.id, '新的名字');
  instances.copy(item.id);
  const reloaded = createInstances(createPreferences(storage), storage);
  expect(createPreferences(storage).snapshot()).toMatchObject({
    theme: 'grass',
    sidebarWidth: 340,
    selectedId: item.id,
  });
  expect((await reloaded.getById(item.id))?.name).toBe('新的名字');
  expect(new Set(reloaded.snapshot().map((entry) => entry.id)).size).toBe(5);
  expect(validInstances(reloaded.snapshot())).toBe(true);
});
test('invalid persisted data is preserved and mutation boundary rejects invalid input', () => {
  const storage = memory();
  storage.setItem('easycraft.instances.v1', '{broken');
  const warnings: string[] = [];
  const instances = createInstances(
    createPreferences(storage),
    storage,
    (message) => warnings.push(message),
  );
  expect(warnings).toHaveLength(1);
  expect(storage.getItem('easycraft.instances.v1.invalid-backup')).toBe(
    '{broken',
  );
  expect(() => instances.add(' ', 'oops', 'vanilla')).toThrow('数据格式无效');
  expect(validPreferences({})).toBe(false);
  expect(
    validPreferences({ ...createPreferences().snapshot(), theme: ['slate'] }),
  ).toBe(false);
  expect(
    validInstances([{ ...instances.snapshot()[0], status: ['ready'] }]),
  ).toBe(false);
});
