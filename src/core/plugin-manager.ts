import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import type { Preferences, Services } from './contracts';
import type { ModCheck } from './native-contracts';

export type PluginCategory = 'tools' | 'instance' | 'appearance';
export type PluginEntry = {
  id: string;
  label: string;
  capability:
    | 'tool.json'
    | 'instance.mod-check'
    | 'appearance.theme'
    | 'appearance.layout';
  position: 'tool' | 'instance-overview' | 'instance-tab' | 'appearance';
};
export type PackageManifest = {
  schemaVersion: 2;
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  icon: string;
  category: PluginCategory;
  capabilities: string[];
  entries: PluginEntry[];
  scope: 'global' | 'instance';
  apiVersion: string;
  minecraft: string[];
  loaders: string[];
  dependencies: Record<string, string>;
  conflicts: string[];
  exclusiveSlots: ('theme' | 'layout')[];
  permissions: string[];
  configVersion: number;
  settings: Record<string, string | number>;
  updateSource?: string;
};
export type InstalledPackage = {
  manifest: PackageManifest;
  file: string;
  sha512: string;
  source: 'local';
};
export type EntryPreference = {
  hidden: boolean;
  pinned: boolean;
  order: number;
};
export type PluginActivation = {
  enabled: boolean;
  instances: string[];
  config: Record<string, string | number>;
  entries: Record<string, EntryPreference>;
};
export type PluginSnapshot = {
  registry: {
    packages: InstalledPackage[];
    states: Record<string, PluginActivation>;
    baseline: Record<string, unknown>;
  };
  safeMode: boolean;
  errors: Record<string, string>;
  appearance: Partial<Preferences>;
  warning: string;
};
type Store = PluginSnapshot & {
  loaded: boolean;
  busy: boolean;
  running: string;
  notice: string;
  error: string;
};
let store: Store = {
  registry: { packages: [], states: {}, baseline: {} },
  safeMode: false,
  errors: {},
  appearance: {},
  warning: '',
  loaded: false,
  busy: false,
  running: '',
  notice: '',
  error: '',
};
const listeners = new Set<() => void>();
function update(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((fn) => fn());
}
export const pluginSnapshot = () => store;
export const usePlugins = () =>
  useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, pluginSnapshot);
let services: Services | undefined;
let loading: Promise<void> | undefined;
let generation = 0;
function accept(snapshot: PluginSnapshot) {
  const previous = store;
  if (snapshot.warning && previous.registry.packages.length) {
    update({
      loaded: true,
      warning: snapshot.warning,
      safeMode: snapshot.safeMode,
    });
    return;
  }
  const slots = new Set<string>();
  for (const current of [previous, snapshot]) {
    for (const p of current.registry.packages) {
      if (
        current.registry.states[p.manifest.id]?.enabled &&
        !current.errors[p.manifest.id]
      )
        for (const slot of p.manifest.exclusiveSlots) slots.add(slot);
    }
  }
  const patch = Object.fromEntries(
    Object.entries(snapshot.appearance).filter(([key]) =>
      slots.has(['theme', 'accentColor'].includes(key) ? 'theme' : 'layout'),
    ),
  );
  update({ ...snapshot, loaded: true });
  // Native registry is authoritative. A crash between commit and this update is
  // repaired on the next load, without exposing preferences to package code.
  if (Object.keys(patch).length) services?.preferences.update(patch);
}
export async function refreshPlugins() {
  const request = ++generation;
  if (!isTauri()) {
    update({ loaded: true, warning: '插件安装和运行需要桌面版。' });
    return;
  }
  try {
    const snapshot = await invoke<PluginSnapshot>('native_plugins');
    if (request === generation) accept(snapshot);
  } catch (e) {
    update({ loaded: true, error: String(e) });
  }
}
export function initializePlugins(value: Services) {
  services = value;
  if (loading) return loading;
  loading = (async () => {
    await refreshPlugins();
    if (!isTauri() || store.warning || store.safeMode) return;
    // Original catalog is retained until every package is safely in managed storage.
    const raw = localStorage.getItem('easycraft.local-plugins.v1');
    if (!raw) return;
    try {
      const legacy: unknown = JSON.parse(raw);
      if (!Array.isArray(legacy) || legacy.length > 50)
        throw Error('旧版插件记录无效，原记录已保留');
      for (const p of legacy) {
        if (
          p &&
          typeof p === 'object' &&
          'id' in p &&
          store.registry.packages.some((x) => x.manifest.id === p.id)
        )
          continue;
        accept(
          await invoke<PluginSnapshot>('native_plugin_change', {
            operation: {
              action: 'install',
              raw: JSON.stringify(p),
              expected: null,
            },
          }),
        );
      }
      localStorage.removeItem('easycraft.local-plugins.v1');
    } catch (e) {
      update({ error: `旧版插件迁移未完成：${String(e)}` });
    }
  })();
  return loading;
}
export type PluginOperation =
  | { action: 'install'; raw: string; expected: string | null }
  | {
      action: 'enable';
      id: string;
      enabled: boolean;
      instances: string[];
      baseline: Record<string, unknown>;
    }
  | { action: 'configure'; id: string; config: PluginActivation['config'] }
  | { action: 'entries'; id: string; entries: PluginActivation['entries'] }
  | { action: 'remove'; id: string; expected: string; acknowledge: boolean }
  | { action: 'recovery'; disabled: boolean };
export async function managePlugin(operation: PluginOperation) {
  if (!isTauri())
    throw Error('此操作需要桌面版；浏览器预览不会安装、运行或删除插件。');
  if (store.busy) throw Error('请等待当前插件操作完成');
  generation++;
  update({ busy: true, error: '', notice: '' });
  const timer = window.setInterval(() => void services?.native.refresh(), 250);
  try {
    const snapshot = await invoke<PluginSnapshot>('native_plugin_change', {
      operation,
    });
    accept(snapshot);
    const name =
      'id' in operation
        ? store.registry.packages.find((p) => p.manifest.id === operation.id)
            ?.manifest.name
        : undefined;
    update({
      notice:
        operation.action === 'install'
          ? '插件已安装'
          : operation.action === 'remove'
            ? '插件包已进入回收站'
            : `${name ?? '插件'}设置已更新`,
    });
    return snapshot;
  } catch (e) {
    await refreshPlugins();
    update({ error: String(e) });
    throw e;
  } finally {
    clearInterval(timer);
    update({ busy: false });
    await services?.native.refresh(true);
  }
}
export function appearanceBaseline(p: Preferences) {
  return {
    theme: p.theme,
    accentColor: p.accentColor ?? '#68b89e',
    layout: p.layout ?? 'default',
    sidebarWidth: p.sidebarWidth,
  };
}
export function pluginEnabled(id: string, instance?: string) {
  const s = store.registry.states[id];
  return (
    !store.safeMode &&
    !store.warning &&
    !store.errors[id] &&
    !!s?.enabled &&
    (!instance || s.instances.includes(instance))
  );
}
export function installedStatus(p: InstalledPackage) {
  if (store.warning) return '暂不可用';
  if (store.running === p.manifest.id) return '正在运行';
  if (store.errors[p.manifest.id]) return '异常';
  const s = store.registry.states[p.manifest.id];
  if (store.safeMode) return '恢复模式已停用';
  return s?.enabled
    ? p.manifest.scope === 'instance'
      ? `已启用 · ${s.instances.length} 个实例`
      : '已启用'
    : '已停用';
}
export function visibleEntries(
  p: InstalledPackage,
  position?: PluginEntry['position'],
) {
  const prefs = store.registry.states[p.manifest.id]?.entries ?? {};
  return p.manifest.entries
    .filter(
      (e) => !prefs[e.id]?.hidden && (!position || e.position === position),
    )
    .sort(
      (a, b) =>
        Number(!!prefs[b.id]?.pinned) - Number(!!prefs[a.id]?.pinned) ||
        (prefs[a.id]?.order ?? 100) - (prefs[b.id]?.order ?? 100),
    );
}
export const toolDrafts = new Map<
  string,
  { input: string; output: string; error: string }
>();
export const extensionReports = new Map<string, ModCheck>();
export async function runPlugin(id: string, instance?: string) {
  if (!isTauri()) throw Error('插件运行需要桌面版');
  if (store.busy) throw Error('请等待当前插件任务完成');
  update({ busy: true, running: id, error: '' });
  const timer = window.setInterval(() => void services?.native.refresh(), 250);
  try {
    if (instance) {
      const result = await invoke<ModCheck>('native_plugin_check', {
        plugin: id,
        id: instance,
      });
      extensionReports.set(`${id}:${instance}`, result);
    } else {
      const draft = toolDrafts.get(id) ?? { input: '', output: '', error: '' };
      const output = await invoke<string>('native_plugin_json', {
        id,
        input: draft.input,
      });
      toolDrafts.set(id, {
        ...draft,
        ...toolDrafts.get(id),
        output,
        error: '',
      });
    }
  } catch (e) {
    update({ error: String(e) });
    if (!instance)
      toolDrafts.set(id, {
        input: '',
        output: '',
        ...toolDrafts.get(id),
        error: String(e),
      });
    throw e;
  } finally {
    clearInterval(timer);
    update({ busy: false, running: '' });
    await services?.native.refresh(true);
  }
}
