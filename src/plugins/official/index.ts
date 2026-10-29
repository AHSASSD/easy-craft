import type { Plugin } from '../../core/plugins/kernel';
import type { StorageAdapter } from '../../core/persistence/store';
import { createInstances, createThemes } from '../../core/services';
import { createDemoLaunch } from '../../core/tasks/demo-launch';
import { createNativeService } from '../../app/native-service';
export function officialPlugins(
  storage?: StorageAdapter,
  warn?: (message: string) => void,
): Plugin[] {
  return [
    {
      manifest: {
        id: 'official.layout',
        version: '1.0.0',
        apiVersion: '1.0.0',
        requires: {},
        provides: {},
        permissions: ['pages'],
      },
      setup(ctx) {
        ctx.registerPage({
          id: 'official.layout.workspace',
          title: '官方工作区布局',
        });
      },
    },
    {
      manifest: {
        id: 'official.vanilla',
        version: '0.2.0',
        apiVersion: '1.0.0',
        requires: {},
        provides: { native: '1.0.0' },
        permissions: ['services'],
      },
      setup(ctx) {
        const native = createNativeService();
        ctx.registerService('native', native);
        ctx.addDisposable(native.stop);
      },
      async start(ctx) {
        await ctx.getService('native').refresh();
      },
    },
    {
      manifest: {
        id: 'official.demo-launch',
        version: '0.1.0',
        apiVersion: '1.0.0',
        requires: { instances: '1.0.0' },
        provides: { launch: '1.0.0' },
        permissions: ['services', 'events'],
      },
      setup(ctx) {
        const launch = createDemoLaunch(
          ctx.getService('instances'),
          (progress) => ctx.emitEvent('launch:progress', progress),
        );
        ctx.registerService('launch', launch);
        ctx.addDisposable(launch.stop);
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
