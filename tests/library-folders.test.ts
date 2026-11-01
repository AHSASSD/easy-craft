import { test, expect } from 'vitest';
import { libraryFolders } from '../src/core/library-folders';
import { instanceGameDirectory } from '../src/core/instance-settings';
import type { NativeInstance } from '../src/core/native-contracts';
const base: NativeInstance = {
  id: 'test',
  name: 'Test',
  version: '1.21.1',
  manifestSha1: 'a'.repeat(40),
  javaMajor: 21,
  fabricVersion: '',
  fabricSha1: '',
};
test('library folders group actual roots without mixing legacy and new layouts', () => {
  const modern = {
    ...base,
    versionFolder: 'ec-test-12345678',
    storageRoot: 'E:/Games',
  };
  const groups = libraryFolders(
    [
      modern,
      { ...modern, id: 'two', storageRoot: 'e:\\Games' },
      { ...base, id: 'old' },
    ],
    'E:/Data',
  );
  expect(groups.map((g) => g.instances.length)).toEqual([2, 1]);
  expect(groups[0].label).toBe('Games');
  expect(groups[0].path).toBe('E:/Games/.minecraft');
  expect(instanceGameDirectory(modern, 'E:/Data')).toBe(
    'E:/Games/.minecraft/versions/ec-test-12345678',
  );
  expect(
    instanceGameDirectory(
      { ...modern, storageRoot: 'E:/Games/.minecraft' },
      'E:/Data',
      false,
    ),
  ).toBe('E:/Games/.minecraft');
  expect(instanceGameDirectory(base, 'E:/Data')).toBe(
    'E:/Data/instances/test/game',
  );
});
