import type { NativeInstance } from './native-contracts';

export function libraryFolders(instances: NativeInstance[], dataRoot: string) {
  const groups = new Map<
    string,
    { path: string; label: string; instances: NativeInstance[] }
  >();
  for (const item of instances) {
    let root = (
      item.versionFolder
        ? (item.storageRoot ?? dataRoot)
        : (item.local?.root ?? item.storageRoot ?? dataRoot)
    )
      .replaceAll('\\', '/')
      .replace(/\/+$/, '');
    if (item.versionFolder && !root.toLowerCase().endsWith('/.minecraft'))
      root += '/.minecraft';
    const key = root.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      const parent = root.toLowerCase().endsWith('/.minecraft')
        ? root.slice(0, -11)
        : root;
      group = {
        path: root,
        label: parent.split('/').at(-1) || parent || '游戏目录',
        instances: [],
      };
      groups.set(key, group);
    }
    group.instances.push(item);
  }
  return [...groups.values()];
}
