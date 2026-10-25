import {
  loaders,
  uiScales,
  type GameInstance,
  type InstanceService,
  type Preferences,
  type PreferencesService,
  type ThemeService,
} from './contracts';
import { createStore, type StorageAdapter } from './persistence/store';
import { validNavigation } from './navigation';
const ids = [
  '9aca7640-cc42-43bd-88ba-03601d0e6631',
  '9aca7640-cc42-43bd-88ba-03601d0e6632',
  '9aca7640-cc42-43bd-88ba-03601d0e6633',
];
export const examples: GameInstance[] = [
  {
    id: ids[0],
    name: '草原上的第一天',
    minecraftVersion: '1.21.1',
    loader: 'vanilla',
    favorite: true,
    status: 'ready',
  },
  {
    id: ids[1],
    name: '轻装出发 · Fabric',
    minecraftVersion: '1.21.1',
    loader: 'fabric',
    loaderVersion: '0.16.10',
    favorite: false,
    status: 'ready',
  },
  {
    id: ids[2],
    name: '山间工坊',
    minecraftVersion: '1.20.1',
    loader: 'forge',
    favorite: false,
    status: 'missing',
  },
];
export const defaultPreferences: Preferences = {
  theme: 'slate',
  sidebarWidth: 300,
  selectedId: ids[0],
  doubleClickLaunch: false,
  developerEnabled: false,
  sort: 'recent',
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function validPreferences(value: unknown): value is Preferences {
  return (
    isRecord(value) &&
    (value.theme === 'slate' || value.theme === 'grass') &&
    typeof value.sidebarWidth === 'number' &&
    value.sidebarWidth >= 240 &&
    value.sidebarWidth <= 420 &&
    typeof value.selectedId === 'string' &&
    typeof value.doubleClickLaunch === 'boolean' &&
    typeof value.developerEnabled === 'boolean' &&
    (value.sort === 'name' || value.sort === 'recent') &&
    (value.backgroundShade === undefined ||
      (typeof value.backgroundShade === 'number' &&
        Number.isInteger(value.backgroundShade) &&
        value.backgroundShade >= 20 &&
        value.backgroundShade <= 80)) &&
    (value.reduceMotion === undefined ||
      typeof value.reduceMotion === 'boolean') &&
    (value.uiScale === undefined ||
      uiScales.some((scale) => scale === value.uiScale)) &&
    (value.navigation === undefined || validNavigation(value.navigation))
  );
}
export function validInstances(value: unknown): value is GameInstance[] {
  return (
    Array.isArray(value) &&
    new Set(
      value.map((item: unknown) => (isRecord(item) ? item.id : undefined)),
    ).size === value.length &&
    value.every(
      (item: unknown) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          item.id,
        ) &&
        typeof item.name === 'string' &&
        item.name.trim().length > 0 &&
        item.name.length <= 60 &&
        typeof item.minecraftVersion === 'string' &&
        /^\d+\.\d+(\.\d+)?$/.test(item.minecraftVersion) &&
        loaders.some((loader) => loader === item.loader) &&
        typeof item.favorite === 'boolean' &&
        typeof item.status === 'string' &&
        ['ready', 'missing', 'installing', 'broken'].includes(item.status) &&
        (item.lastPlayedAt === undefined ||
          (typeof item.lastPlayedAt === 'string' &&
            Number.isFinite(Date.parse(item.lastPlayedAt)))) &&
        (item.loaderVersion === undefined ||
          typeof item.loaderVersion === 'string') &&
        (item.gameDirectory === undefined ||
          typeof item.gameDirectory === 'string'),
    )
  );
}
export function createPreferences(
  storage?: StorageAdapter,
  warn?: (message: string) => void,
): PreferencesService {
  const store = createStore(
    'easycraft.preferences.v1',
    defaultPreferences,
    validPreferences,
    storage,
    warn,
  );
  return {
    ...store,
    update: (patch) => store.set({ ...store.snapshot(), ...patch }),
  };
}
export function createInstances(
  preferences: PreferencesService,
  storage?: StorageAdapter,
  warn?: (message: string) => void,
): InstanceService {
  const store = createStore(
    'easycraft.instances.v1',
    structuredClone(examples),
    validInstances,
    storage,
    warn,
  );
  const change = (id: string, patch: Partial<GameInstance>) => {
    if (!store.snapshot().some((item) => item.id === id))
      throw new Error('实例不存在');
    store.set(
      store
        .snapshot()
        .map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };
  return {
    ...store,
    list: async () => structuredClone(store.snapshot()),
    getById: async (id) =>
      structuredClone(store.snapshot().find((item) => item.id === id) ?? null),
    select: async (id) => {
      if (!store.snapshot().some((item) => item.id === id))
        throw new Error('实例不存在');
      preferences.update({ selectedId: id });
    },
    add: (name, minecraftVersion, loader) =>
      store.set([
        ...store.snapshot(),
        {
          id: crypto.randomUUID(),
          name: name.trim(),
          minecraftVersion: minecraftVersion.trim(),
          loader,
          favorite: false,
          status: 'ready',
        },
      ]),
    rename: (id, name) => change(id, { name: name.trim() }),
    copy: (id) => {
      const source = store.snapshot().find((item) => item.id === id);
      if (!source) throw new Error('实例不存在');
      store.set([
        ...store.snapshot(),
        {
          ...source,
          id: crypto.randomUUID(),
          name: `${source.name.slice(0, 50)} · 副本`,
          lastPlayedAt: undefined,
          gameDirectory: undefined,
        },
      ]);
    },
    favorite: (id) =>
      change(id, {
        favorite: !store.snapshot().find((item) => item.id === id)?.favorite,
      }),
    markPlayed: (id) => change(id, { lastPlayedAt: new Date().toISOString() }),
  };
}
export function createThemes(preferences: PreferencesService): ThemeService {
  return {
    listThemes: () => [
      { id: 'slate', name: '深板岩夜色', description: '沉静夜色，青绿点亮' },
      { id: 'grass', name: '草方块亮色', description: '明亮草地，轻装出发' },
    ],
    activateTheme: (theme) => preferences.update({ theme }),
  };
}
