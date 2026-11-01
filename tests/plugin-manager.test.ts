// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import type { Services } from '../src/core/contracts';
import type { PluginSnapshot } from '../src/core/plugin-manager';
const bridge = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => bridge.desktop,
  invoke: bridge.invoke,
}));
const snapshot = (capability = 'appearance.theme'): PluginSnapshot => ({
  registry: {
    packages: [
      {
        manifest: {
          schemaVersion: 2,
          id: 'test.package',
          name: 'Package',
          author: 'Test',
          version: '1.0.0',
          description: '',
          icon: 'code',
          category: capability.startsWith('tool') ? 'tools' : 'appearance',
          scope: 'global',
          apiVersion: '1.0.0',
          configVersion: 1,
          capabilities: [capability],
          entries: [],
          settings: {},
          dependencies: {},
          conflicts: [],
          minecraft: [],
          loaders: [],
          permissions: [],
          exclusiveSlots: capability.startsWith('appearance') ? ['theme'] : [],
        },
        file: 'plugins/packages/test.package/test.json',
        sha512: 'a'.repeat(128),
        source: 'local',
      },
    ],
    states: {
      'test.package': {
        enabled: false,
        instances: [],
        config: {},
        entries: {},
      },
    },
    baseline: { theme: 'grass' },
  },
  safeMode: false,
  errors: {},
  appearance: { theme: 'grass' },
  warning: '',
});
const preferences = {
  snapshot: () => ({ theme: 'grass', sidebarWidth: 280 }),
  update: vi.fn(),
};
const services = {
  preferences,
  native: { refresh: vi.fn() },
} as unknown as Services;
beforeEach(() => {
  vi.resetModules();
  bridge.desktop = true;
  bridge.invoke.mockReset();
  preferences.update.mockReset();
  localStorage.clear();
});

test('activation applies supported appearance and disabling restores baseline without overwriting later personal changes', async () => {
  const s = snapshot();
  bridge.invoke.mockResolvedValue(s);
  const manager = await import('../src/core/plugin-manager');
  await manager.initializePlugins(services);
  expect(preferences.update).not.toHaveBeenCalled();
  const active = structuredClone(s);
  active.registry.states['test.package'].enabled = true;
  active.appearance = { theme: 'slate' };
  bridge.invoke.mockResolvedValue(active);
  await manager.managePlugin({
    action: 'enable',
    id: 'test.package',
    enabled: true,
    instances: [],
    baseline: {},
  });
  expect(preferences.update).toHaveBeenLastCalledWith({ theme: 'slate' });
  bridge.invoke.mockResolvedValue(s);
  await manager.managePlugin({
    action: 'enable',
    id: 'test.package',
    enabled: false,
    instances: [],
    baseline: {},
  });
  expect(preferences.update).toHaveBeenLastCalledWith({ theme: 'grass' });
  preferences.update.mockClear();
  await manager.refreshPlugins();
  expect(preferences.update).not.toHaveBeenCalled();
});

test('unavailable external directory retains the visible catalog and never treats enabled records as runnable', async () => {
  const s = snapshot();
  s.registry.states['test.package'].enabled = true;
  bridge.invoke.mockResolvedValue(s);
  const manager = await import('../src/core/plugin-manager');
  await manager.initializePlugins(services);
  expect(manager.pluginEnabled('test.package')).toBe(true);
  const unavailable = snapshot();
  unavailable.registry.packages = [];
  unavailable.warning = '插件目录暂不可用';
  bridge.invoke.mockResolvedValue(unavailable);
  await manager.refreshPlugins();
  expect(manager.pluginSnapshot().registry.packages).toHaveLength(1);
  expect(manager.pluginEnabled('test.package')).toBe(false);
  bridge.invoke.mockResolvedValue(s);
  await manager.refreshPlugins();
  expect(manager.pluginEnabled('test.package')).toBe(true);
});

test('tool completion preserves input edited while its native task was running', async () => {
  const s = snapshot('tool.json');
  s.registry.states['test.package'].enabled = true;
  bridge.invoke.mockResolvedValue(s);
  const manager = await import('../src/core/plugin-manager');
  await manager.initializePlugins(services);
  manager.toolDrafts.set('test.package', {
    input: '{"old":1}',
    output: '',
    error: '',
  });
  let complete!: (value: string) => void;
  bridge.invoke.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const running = manager.runPlugin('test.package');
  expect(manager.pluginSnapshot().running).toBe('test.package');
  manager.toolDrafts.set('test.package', {
    input: '{"new":2}',
    output: '',
    error: '',
  });
  complete('{\n  "old": 1\n}');
  await running;
  expect(manager.toolDrafts.get('test.package')?.input).toBe('{"new":2}');
  expect(manager.toolDrafts.get('test.package')?.output).toContain('old');
  expect(manager.pluginSnapshot().running).toBe('');
});

test('browser preview cannot fake installation or system recycling', async () => {
  bridge.desktop = false;
  const manager = await import('../src/core/plugin-manager');
  await manager.initializePlugins(services);
  await expect(
    manager.managePlugin({
      action: 'remove',
      id: 'test.package',
      expected: '',
      acknowledge: false,
    }),
  ).rejects.toThrow('桌面版');
  expect(bridge.invoke).not.toHaveBeenCalled();
});
