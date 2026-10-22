import { expect, test } from 'vitest';
import {
  createInstances,
  createPreferences,
  createThemes,
  validInstances,
  validPreferences,
} from '../src/core/services';
import type { StorageAdapter } from '../src/core/persistence/store';
function memory(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
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
