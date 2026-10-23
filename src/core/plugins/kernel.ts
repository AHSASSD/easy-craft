import type { LaunchProgress, Services, ThemeDefinition } from '../contracts';
type ServiceId = keyof Services;
type Versions = Partial<Record<ServiceId, string>>;
type Permission = 'services' | 'events' | 'pages' | 'themes';
export type PluginManifest = {
  id: string;
  version: string;
  apiVersion: string;
  requires: Versions;
  provides: Versions;
  permissions: Permission[];
};
export type PageDefinition = { id: string; title: string };
export type Events = {
  'instances:changed': { count: number };
  'launch:progress': LaunchProgress;
  'kernel:ready': { plugins: string[] };
};
type Dispose = () => void | Promise<void>;
export interface PluginContext {
  getService<K extends ServiceId>(id: K): Services[K];
  registerService<K extends ServiceId>(id: K, value: Services[K]): void;
  onEvent<K extends keyof Events>(
    event: K,
    listener: (data: Events[K]) => void,
  ): void;
  emitEvent<K extends keyof Events>(event: K, data: Events[K]): void;
  registerPage(page: PageDefinition): void;
  registerTheme(theme: ThemeDefinition): void;
  addDisposable(dispose: Dispose): void;
}
export interface Plugin {
  manifest: PluginManifest;
  setup(ctx: PluginContext): void | Promise<void>;
  start?(ctx: PluginContext): void | Promise<void>;
  stop?(ctx: PluginContext): void | Promise<void>;
}
export class DisposableScope {
  private disposables: Dispose[] = [];
  private closed = false;
  get isClosed() {
    return this.closed;
  }
  add(dispose: Dispose) {
    if (this.closed) throw new Error('插件已停止');
    this.disposables.push(dispose);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const dispose of this.disposables.reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.disposables = [];
    if (errors.length) throw new AggregateError(errors, '插件清理失败');
  }
}
function validManifest(manifest: PluginManifest) {
  const version = /^\d+\.\d+\.\d+$/;
  if (
    !manifest ||
    typeof manifest.id !== 'string' ||
    !/^[a-z0-9.-]+$/.test(manifest.id) ||
    !version.test(manifest.version) ||
    manifest.apiVersion !== '1.0.0' ||
    !manifest.requires ||
    !manifest.provides ||
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.some(
      (item) => !['services', 'events', 'pages', 'themes'].includes(item),
    )
  )
    throw new Error(`插件清单或 API 版本不兼容：${manifest?.id ?? 'unknown'}`);
  for (const entries of [manifest.requires, manifest.provides])
    for (const [id, contractVersion] of Object.entries(entries))
      if (
        !['preferences', 'instances', 'themes', 'launch', 'native'].includes(
          id,
        ) ||
        typeof contractVersion !== 'string' ||
        !version.test(contractVersion)
      )
        throw new Error(`无效服务契约：${id}`);
}
export function validProgress(data: unknown): data is LaunchProgress {
  if (!data || typeof data !== 'object') return false;
  const item = data as Record<string, unknown>;
  return (
    typeof item.step === 'string' &&
    ['validate', 'prepare', 'arguments', 'finish'].includes(item.step) &&
    typeof item.status === 'string' &&
    ['pending', 'running', 'done', 'failed', 'cancelled'].includes(
      item.status,
    ) &&
    typeof item.message === 'string' &&
    (item.percent === undefined ||
      (typeof item.percent === 'number' &&
        Number.isFinite(item.percent) &&
        item.percent >= 0 &&
        item.percent <= 100))
  );
}
export class PluginManager {
  private services = new Map<
    ServiceId,
    { owner: string; version: string; value: unknown }
  >();
  private listeners = new Map<keyof Events, Set<(value: never) => void>>();
  private pages = new Map<string, PageDefinition>();
  private themes = new Map<string, ThemeDefinition>();
  private loaded: {
    plugin: Plugin;
    scope: DisposableScope;
    context: PluginContext;
  }[] = [];
  private busy = false;
  constructor(preferences: Services['preferences']) {
    this.services.set('preferences', {
      owner: 'host',
      version: '1.0.0',
      value: preferences,
    });
  }
  getService<K extends ServiceId>(id: K): Services[K] {
    const service = this.services.get(id);
    if (!service) throw new Error(`缺少服务：${id}`);
    return service.value as Services[K];
  }
  inspect() {
    return {
      plugins: this.loaded.map(({ plugin }) => plugin.manifest.id),
      services: [...this.services.keys()],
      pages: [...this.pages.values()],
      themes: [...this.themes.values()],
      listeners: [...this.listeners.values()].reduce(
        (sum, set) => sum + set.size,
        0,
      ),
    };
  }
  emit<K extends keyof Events>(event: K, data: Events[K]) {
    if (!data || typeof data !== 'object')
      throw new Error(`无效事件数据：${event}`);
    const valid =
      event === 'launch:progress'
        ? validProgress(data)
        : event === 'instances:changed'
          ? typeof (data as Events['instances:changed']).count === 'number' &&
            Number.isInteger((data as Events['instances:changed']).count) &&
            (data as Events['instances:changed']).count >= 0
          : event === 'kernel:ready' &&
            Array.isArray((data as Events['kernel:ready']).plugins) &&
            (data as Events['kernel:ready']).plugins.every(
              (item) => typeof item === 'string',
            );
    if (!valid) throw new Error(`无效事件数据：${event}`);
    this.listeners.get(event)?.forEach((listener) => listener(data as never));
  }
  private order(plugins: Plugin[]) {
    const providers = new Map<
      ServiceId,
      { plugin?: Plugin; version: string }
    >();
    this.services.forEach((entry, id) =>
      providers.set(id, { version: entry.version }),
    );
    const ids = new Set<string>();
    for (const plugin of plugins) {
      validManifest(plugin.manifest);
      if (ids.has(plugin.manifest.id))
        throw new Error(`重复插件：${plugin.manifest.id}`);
      ids.add(plugin.manifest.id);
      for (const [id, version] of Object.entries(plugin.manifest.provides) as [
        ServiceId,
        string,
      ][]) {
        if (providers.has(id)) throw new Error(`重复服务注册：${id}`);
        providers.set(id, { plugin, version });
      }
    }
    const visiting = new Set<Plugin>();
    const visited = new Set<Plugin>();
    const result: Plugin[] = [];
    const visit = (plugin: Plugin) => {
      if (visited.has(plugin)) return;
      if (visiting.has(plugin))
        throw new Error(`循环依赖：${plugin.manifest.id}`);
      visiting.add(plugin);
      for (const [id, version] of Object.entries(plugin.manifest.requires) as [
        ServiceId,
        string,
      ][]) {
        const provider = providers.get(id);
        if (!provider)
          throw new Error(`缺少依赖：${plugin.manifest.id} 需要 ${id}`);
        if (provider.version !== version)
          throw new Error(
            `服务版本不兼容：${id} 需要 ${version}，提供 ${provider.version}`,
          );
        if (provider.plugin === plugin)
          throw new Error(`循环依赖：${plugin.manifest.id} 依赖自身服务 ${id}`);
        if (provider.plugin) visit(provider.plugin);
      }
      visiting.delete(plugin);
      visited.add(plugin);
      result.push(plugin);
    };
    plugins.forEach(visit);
    return result;
  }
  private context(plugin: Plugin, scope: DisposableScope): PluginContext {
    const check = (permission?: Permission) => {
      if (scope.isClosed) throw new Error('插件已停止');
      if (permission && !plugin.manifest.permissions.includes(permission))
        throw new Error(`插件权限不足：${permission}`);
    };
    const register = <T>(
      map: Map<string, T>,
      id: string,
      value: T,
      permission: Permission,
    ) => {
      check(permission);
      if (!id || map.has(id)) throw new Error(`重复或无效扩展：${id}`);
      map.set(id, value);
      scope.add(() => {
        map.delete(id);
      });
    };
    return {
      getService: (id) => {
        check();
        if (
          !(id in plugin.manifest.requires) &&
          !(id in plugin.manifest.provides)
        )
          throw new Error(`未声明服务依赖：${id}`);
        return this.getService(id);
      },
      registerService: (id, value) => {
        check('services');
        const version = plugin.manifest.provides[id];
        if (!version) throw new Error(`未声明服务提供：${id}`);
        if (this.services.has(id)) throw new Error(`重复服务注册：${id}`);
        const methods = {
          native: [
            'planResources',
            'installResources',
            'searchResources',
            'resourceDetail',
            'content',
            'toggleContent',
            'importContent',
            'contentImage',
            'openContent',
            'renameInstance',
            'worlds',
            'world',
            'saveWorld',
            'options',
            'saveOptions',
            'avatar',
            'saveAvatar',
            'snapshot',
            'subscribe',
            'refresh',
            'versions',
            'previewPack',
            'fabricVersions',
            'saveSettings',
            'probeJava',
            'memory',
            'optimizeMemory',
            'beginLogin',
            'pollLogin',
            'cancelLogin',
            'openLogin',
            'signOut',
            'install',
            'launch',
            'cancel',
          ],
          preferences: ['snapshot', 'subscribe', 'update'],
          instances: [
            'snapshot',
            'subscribe',
            'list',
            'getById',
            'select',
            'add',
            'rename',
            'copy',
            'favorite',
            'markPlayed',
          ],
          themes: ['listThemes', 'activateTheme'],
          launch: ['simulateLaunch'],
        };
        if (
          !value ||
          methods[id].some(
            (method) =>
              typeof (value as unknown as Record<string, unknown>)[method] !==
              'function',
          )
        )
          throw new Error(`无效服务实现：${id}`);
        this.services.set(id, { owner: plugin.manifest.id, version, value });
        scope.add(() => {
          this.services.delete(id);
        });
      },
      onEvent: (event, listener) => {
        check('events');
        const set = this.listeners.get(event) ?? new Set();
        this.listeners.set(event, set);
        set.add(listener as (value: never) => void);
        scope.add(() => {
          set.delete(listener as (value: never) => void);
          if (!set.size) this.listeners.delete(event);
        });
      },
      emitEvent: (event, data) => {
        check('events');
        this.emit(event, data);
      },
      registerPage: (page) => {
        if (typeof page.id !== 'string' || typeof page.title !== 'string')
          throw new Error('无效页面定义');
        register(this.pages, page.id, page, 'pages');
      },
      registerTheme: (theme) => {
        if (
          !['slate', 'grass'].includes(theme.id) ||
          typeof theme.name !== 'string' ||
          typeof theme.description !== 'string'
        )
          throw new Error('无效主题定义');
        register(this.themes, theme.id, theme, 'themes');
      },
      addDisposable: (dispose) => {
        check();
        scope.add(dispose);
      },
    };
  }
  async load(plugins: Plugin[]) {
    if (this.busy || this.loaded.length)
      throw new Error('内核正在运行，请先停止插件');
    this.busy = true;
    try {
      for (const plugin of this.order(plugins)) {
        const scope = new DisposableScope();
        const context = this.context(plugin, scope);
        this.loaded.push({ plugin, scope, context });
        await plugin.setup(context);
        for (const id of Object.keys(plugin.manifest.provides) as ServiceId[])
          if (this.services.get(id)?.owner !== plugin.manifest.id)
            throw new Error(`插件未注册声明服务：${id}`);
        await plugin.start?.(context);
      }
      this.emit('kernel:ready', { plugins: this.inspect().plugins });
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '插件加载失败且清理发生错误',
          { cause: cleanupError },
        );
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async cleanup() {
    const errors: unknown[] = [];
    for (const entry of this.loaded.reverse()) {
      try {
        await entry.plugin.stop?.(entry.context);
      } catch (error) {
        errors.push(error);
      }
      try {
        await entry.scope.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.loaded = [];
    if (errors.length)
      throw new AggregateError(errors, '插件停止失败，已尝试全部清理');
  }
  async stop() {
    if (this.busy) throw new Error('内核操作进行中');
    this.busy = true;
    try {
      await this.cleanup();
    } finally {
      this.busy = false;
    }
  }
}
