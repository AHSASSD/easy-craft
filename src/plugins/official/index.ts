import type { Plugin } from '../../core/plugins/kernel';
import type { StorageAdapter } from '../../core/persistence/store';
import { createInstances, createThemes } from '../../core/services';
export function officialPlugins(
  storage?: StorageAdapter,
  warn?: (message: string) => void,
): Plugin[] {
  return [
    {
      manifest: {
        id: 'official.demo-launch',
        version: '0.1.0',
        apiVersion: '1.0.0',
        requires: { instances: '1.0.0' },
        provides: { launch: '1.0.0' },
        permissions: ['services'],
      },
      setup(ctx) {
        ctx.getService('instances');
        ctx.registerService('launch', {
          simulateLaunch: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                throw new Error('模拟工作流将在 Milestone D 接入');
              },
            }),
          }),
        });
      },
    },
    {
      manifest: {
        id: 'official.themes',
        version: '0.1.0',
        apiVersion: '1.0.0',
        requires: { preferences: '1.0.0' },
        provides: { themes: '1.0.0' },
        permissions: ['services', 'themes'],
      },
      setup(ctx) {
        const themes = createThemes(ctx.getService('preferences'));
        themes.listThemes().forEach((theme) => ctx.registerTheme(theme));
        ctx.registerService('themes', themes);
      },
    },
    {
      manifest: {
        id: 'official.instances',
        version: '0.1.0',
        apiVersion: '1.0.0',
        requires: { preferences: '1.0.0' },
        provides: { instances: '1.0.0' },
        permissions: ['services', 'events', 'pages'],
      },
      setup(ctx) {
        const instances = createInstances(
          ctx.getService('preferences'),
          storage,
          warn,
        );
        ctx.registerService('instances', instances);
        ctx.registerPage({
          id: 'official.instances.inspector',
          title: '实例服务检查器',
        });
        ctx.addDisposable(
          instances.subscribe(() =>
            ctx.emitEvent('instances:changed', {
              count: instances.snapshot().length,
            }),
          ),
        );
      },
    },
  ];
}
