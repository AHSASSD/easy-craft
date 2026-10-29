import { expect, test, vi } from 'vitest';
import {
  DisposableScope,
  PluginManager,
  type Plugin,
  type PluginContext,
} from '../src/core/plugins/kernel';
import { createPreferences, createThemes } from '../src/core/services';
import { officialPlugins } from '../src/plugins/official';
const manager = () => new PluginManager(createPreferences());
const plugin = (id: string, setup: Plugin['setup'] = () => {}): Plugin => ({
  manifest: {
    id,
    version: '0.1.0',
    apiVersion: '1.0.0',
    requires: {},
    provides: {},
    permissions: ['services', 'events', 'pages', 'themes'],
  },
  setup,
});
test('official plugins start in contract dependency order and reload without resources leaking', async () => {
  const kernel = manager();
  for (let index = 0; index < 2; index++) {
    await kernel.load(officialPlugins());
    expect(kernel.inspect().plugins.indexOf('official.instances')).toBeLessThan(
      kernel.inspect().plugins.indexOf('official.demo-launch'),
    );
    expect(kernel.getService('themes').listThemes()).toHaveLength(2);
    expect(await kernel.getService('instances').list()).toHaveLength(3);
    expect(kernel.inspect().pages).toHaveLength(2);
    await kernel.stop();
    expect(kernel.inspect()).toEqual({
      plugins: [],
      services: ['preferences'],
      pages: [],
      themes: [],
      listeners: 0,
    });
  }
});
test('missing dependency is readable and starts nothing', async () => {
  const kernel = manager();
  await expect(
    kernel.load([
      officialPlugins().find(
        (plugin) => plugin.manifest.id === 'official.demo-launch',
      )!,
    ]),
  ).rejects.toThrow('缺少依赖');
  expect(kernel.inspect().plugins).toEqual([]);
});
test('cycles are detected before setup', async () => {
  const a = plugin('a', vi.fn());
  const b = plugin('b', vi.fn());
  a.manifest.requires = { launch: '1.0.0' };
  a.manifest.provides = { themes: '1.0.0' };
  b.manifest.requires = { themes: '1.0.0' };
  b.manifest.provides = { launch: '1.0.0' };
  await expect(manager().load([a, b])).rejects.toThrow('循环依赖');
  expect(a.setup).not.toHaveBeenCalled();
});
test('API and contract versions are exact and incompatible versions fail', async () => {
  const a = plugin('a');
  a.manifest.requires = { preferences: '2.0.0' };
  await expect(manager().load([a])).rejects.toThrow('服务版本不兼容');
  a.manifest.apiVersion = '2.0.0';
  await expect(manager().load([a])).rejects.toThrow('API 版本不兼容');
});
test('duplicate provider and duplicate service registration cannot overwrite data', async () => {
  const a = plugin('a');
  const b = plugin('b');
  a.manifest.provides = { themes: '1.0.0' };
  b.manifest.provides = { themes: '1.0.0' };
  await expect(manager().load([a, b])).rejects.toThrow('重复服务注册');
  const kernel = manager();
  a.setup = (ctx) => {
    const themes = createThemes(createPreferences());
    ctx.registerService('themes', themes);
    ctx.registerService('themes', themes);
  };
  await expect(kernel.load([a])).rejects.toThrow('重复服务注册');
  expect(kernel.inspect().services).toEqual(['preferences']);
});
test('failure in start rolls back prior and current resources and reverses lifecycle order', async () => {
  const calls: string[] = [];
  const kernel = manager();
  const a = plugin('a', (ctx) => {
    ctx.registerPage({ id: 'a', title: 'A' });
    ctx.addDisposable(() => {
      calls.push('dispose-a');
    });
  });
  a.start = () => {
    calls.push('start-a');
  };
  a.stop = () => {
    calls.push('stop-a');
  };
  const b = plugin('b', (ctx) => {
    ctx.registerTheme({ id: 'slate', name: 'A', description: 'A' });
    ctx.onEvent('instances:changed', () => {});
  });
  b.start = () => {
    throw new Error('start failed');
  };
  b.stop = () => {
    calls.push('stop-b');
  };
  await expect(kernel.load([a, b])).rejects.toThrow('start failed');
  expect(calls).toEqual(['start-a', 'stop-b', 'stop-a', 'dispose-a']);
  expect(kernel.inspect()).toEqual({
    plugins: [],
    services: ['preferences'],
    pages: [],
    themes: [],
    listeners: 0,
  });
});
test('listeners do not duplicate across restarts and old contexts are revoked', async () => {
  const kernel = manager();
  const listener = vi.fn();
  let saved: PluginContext | undefined;
  const a = plugin('a', (ctx) => {
    saved = ctx;
    ctx.onEvent('instances:changed', listener);
    ctx.registerPage({ id: 'a', title: 'A' });
  });
  await kernel.load([a]);
  kernel.emit('instances:changed', { count: 1 });
  await kernel.stop();
  kernel.emit('instances:changed', { count: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(() => saved!.registerPage({ id: 'stale', title: 'stale' })).toThrow(
    '插件已停止',
  );
  await kernel.load([a]);
  kernel.emit('instances:changed', { count: 1 });
  expect(listener).toHaveBeenCalledTimes(2);
  await kernel.stop();
});
test('capability and declared-service checks reject access', async () => {
  const a = plugin('a', (ctx) => ctx.registerPage({ id: 'bad', title: 'bad' }));
  a.manifest.permissions = [];
  await expect(manager().load([a])).rejects.toThrow('权限不足');
  a.setup = (ctx) => {
    ctx.getService('preferences');
  };
  await expect(manager().load([a])).rejects.toThrow('未声明服务依赖');
});
test('disposal attempts every cleanup even when one fails', async () => {
  const scope = new DisposableScope();
  const calls: number[] = [];
  scope.add(() => {
    calls.push(1);
  });
  scope.add(() => {
    calls.push(2);
    throw new Error('cleanup');
  });
  scope.add(() => {
    calls.push(3);
  });
  await expect(scope.close()).rejects.toThrow('插件清理失败');
  expect(calls).toEqual([3, 2, 1]);
  await scope.close();
});
test('invalid event payloads are rejected at runtime', () => {
  const kernel = manager();
  expect(() => kernel.emit('instances:changed', { count: -1 })).toThrow(
    '无效事件数据',
  );
  expect(() =>
    kernel.emit('launch:progress', {
      step: 'finish',
      status: 'done',
      message: 'test',
      percent: 101,
    }),
  ).toThrow('无效事件数据');
});
