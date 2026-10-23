import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  DeviceCode,
  JavaInfo,
  MemoryInfo,
  PackPreview,
  NativeService,
  NativeSnapshot,
  NativeState,
  WorldEntry,
  WorldSettings,
  ClientOptions,
  ContentEntry,
  ResourceSearch,
  ResourceDetail,
  ResourcePlan,
} from '../core/native-contracts';
import { isRecord } from '../core/services';
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const resourceId = (value: unknown): value is string =>
  string(value) && /^[A-Za-z0-9]{1,64}$/.test(value);
const bounded = (value: unknown, max: number): value is string =>
  string(value) && value.length <= max;
export function validResourcePlan(value: unknown): value is ResourcePlan {
  return (
    isRecord(value) &&
    string(value.token) &&
    /^[a-f0-9-]{36}$/.test(value.token) &&
    bounded(value.instanceId, 128) &&
    bounded(value.gameVersion, 100) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 130 &&
    value.warnings.every((w: unknown) => bounded(w, 2048)) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.length <= 64 &&
    value.files.every(
      (f: unknown) =>
        isRecord(f) &&
        resourceId(f.project) &&
        resourceId(f.version) &&
        bounded(f.path, 256) &&
        /^(mods|resourcepacks|shaderpacks)\/[^/\\]+$/.test(f.path) &&
        integer(f.size) &&
        f.size <= 512 * 1024 * 1024 &&
        string(f.sha512) &&
        /^[a-f0-9]{128}$/.test(f.sha512) &&
        string(f.sha1) &&
        /^[a-fA-F0-9]{40}$/.test(f.sha1) &&
        ['add', 'keep'].includes(f.action as string),
    )
  );
}
export function validResourceDetail(value: unknown): value is ResourceDetail {
  return (
    isRecord(value) &&
    resourceId(value.id) &&
    bounded(value.title, 512) &&
    bounded(value.description, 4096) &&
    bounded(value.body, 256 * 1024) &&
    Array.isArray(value.versions) &&
    value.versions.length <= 1000 &&
    value.versions.every(
      (version: unknown) =>
        isRecord(version) &&
        resourceId(version.id) &&
        bounded(version.name, 512) &&
        bounded(version.number, 256) &&
        bounded(version.environment, 64) &&
        Array.isArray(version.loaders) &&
        version.loaders.length <= 512 &&
        version.loaders.every((v: unknown) => bounded(v, 128)) &&
        Array.isArray(version.files) &&
        version.files.length > 0 &&
        version.files.length <= 64 &&
        version.files.every(
          (file: unknown) =>
            isRecord(file) &&
            bounded(file.filename, 512) &&
            integer(file.size) &&
            file.size <= 2 * 1024 * 1024 * 1024 &&
            string(file.sha1) &&
            /^[a-fA-F0-9]{40}$/.test(file.sha1),
        ) &&
        Array.isArray(version.dependencies) &&
        version.dependencies.length <= 256 &&
        version.dependencies.every(
          (dep: unknown) =>
            isRecord(dep) &&
            (dep.projectId === null || resourceId(dep.projectId)) &&
            (dep.versionId === null || resourceId(dep.versionId)) &&
            ['required', 'optional', 'embedded', 'incompatible'].includes(
              dep.kind as string,
            ),
        ),
    )
  );
}
const unit = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
export function validWorld(value: unknown): value is WorldSettings {
  return (
    isRecord(value) &&
    string(value.revision) &&
    /^[a-f0-9]{40}$/.test(value.revision) &&
    integer(value.difficulty) &&
    value.difficulty <= 3 &&
    typeof value.difficultyLocked === 'boolean' &&
    typeof value.hardcore === 'boolean' &&
    (value.allowCommands === null ||
      typeof value.allowCommands === 'boolean') &&
    (value.gameMode === null ||
      (integer(value.gameMode) && value.gameMode <= 3)) &&
    (value.dayTime === null ||
      (string(value.dayTime) && /^-?\d{1,19}$/.test(value.dayTime))) &&
    (value.weather === null ||
      ['clear', 'rain', 'thunder'].includes(value.weather as string)) &&
    Array.isArray(value.gameRules) &&
    value.gameRules.length <= 1024 &&
    value.gameRules.every(
      (rule: unknown) =>
        isRecord(rule) &&
        string(rule.key) &&
        rule.key.length <= 128 &&
        string(rule.value) &&
        rule.value.length <= 128 &&
        ['boolean', 'integer', 'text'].includes(rule.kind as string),
    )
  );
}
function validOptions(value: unknown): value is ClientOptions {
  return (
    isRecord(value) &&
    string(value.revision) &&
    (value.revision === 'missing' || /^[a-f0-9]{40}$/.test(value.revision)) &&
    unit(value.masterVolume) &&
    unit(value.musicVolume) &&
    integer(value.renderDistance) &&
    value.renderDistance >= 2 &&
    value.renderDistance <= 64 &&
    typeof value.fullscreen === 'boolean'
  );
}
function validMemory(value: unknown): value is MemoryInfo {
  return (
    isRecord(value) &&
    integer(value.totalMb) &&
    value.totalMb > 0 &&
    integer(value.availableMb) &&
    value.availableMb <= value.totalMb &&
    integer(value.recommendedMb) &&
    value.recommendedMb >= 512 &&
    value.recommendedMb <= 16384 &&
    integer(value.reserveMb)
  );
}
export function validNativeState(value: unknown): value is NativeState {
  if (
    !isRecord(value) ||
    !string(value.dataRoot) ||
    !isRecord(value.settings) ||
    !isRecord(value.task) ||
    !Array.isArray(value.instances)
  )
    return false;
  const { settings, task, account } = value;
  return (
    string(settings.clientId) &&
    string(settings.javaPath) &&
    integer(settings.memoryMb) &&
    settings.memoryMb >= 512 &&
    settings.memoryMb <= 16384 &&
    ['auto', 'manual'].includes(settings.memoryMode as string) &&
    typeof settings.optimizeMemory === 'boolean' &&
    ['microsoft', 'offline'].includes(settings.launchMode as string) &&
    string(settings.offlineName) &&
    (settings.offlineName === '' ||
      /^[A-Za-z0-9_]{3,16}$/.test(settings.offlineName)) &&
    (settings.launchMode !== 'offline' || settings.offlineName !== '') &&
    (account === null ||
      (isRecord(account) &&
        string(account.id) &&
        string(account.name) &&
        string(account.xuid))) &&
    typeof value.loginPending === 'boolean' &&
    (value.loginCode === null ||
      (isRecord(value.loginCode) &&
        string(value.loginCode.userCode) &&
        integer(value.loginCode.interval) &&
        integer(value.loginCode.expiresIn))) &&
    value.instances.every(
      (item: unknown) =>
        isRecord(item) &&
        string(item.id) &&
        string(item.name) &&
        string(item.version) &&
        string(item.manifestSha1) &&
        /^[0-9a-f]{40}$/i.test(item.manifestSha1) &&
        integer(item.javaMajor) &&
        string(item.fabricVersion) &&
        string(item.fabricSha1) &&
        (item.fabricVersion === ''
          ? item.fabricSha1 === ''
          : /^[A-Za-z0-9._+-]{1,100}$/.test(item.fabricVersion) &&
            /^[a-f0-9]{40}$/.test(item.fabricSha1)),
    ) &&
    string(task.status) &&
    ['idle', 'running', 'succeeded', 'failed', 'cancelled'].includes(
      task.status,
    ) &&
    string(task.phase) &&
    string(task.message) &&
    integer(task.completed) &&
    integer(task.total) &&
    Array.isArray(task.logs) &&
    task.logs.length <= 200 &&
    task.logs.every(string) &&
    (task.pid === null || integer(task.pid))
  );
}
export function createNativeService(
  available = isTauri(),
  call: typeof invoke = invoke,
): NativeService & { stop(): void } {
  let snapshot: NativeSnapshot = {
    available,
    state: null,
    error: '',
    avatar: null,
  };
  const listeners = new Set<() => void>();
  let stopped = false;
  let refreshing: Promise<void> | null = null;
  const identity = (state: NativeState | null) =>
    JSON.stringify([
      state?.settings.launchMode,
      state?.settings.offlineName,
      state?.account?.id,
      state?.account?.skinUrl,
    ]);
  const update = (next: NativeSnapshot) => {
    if (stopped) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  async function request(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!available)
      throw new Error('真实下载与启动需要桌面版；浏览器仅提供演示。');
    if (stopped) throw new Error('原版服务已停止');
    try {
      return await call(command, args);
    } catch (error) {
      throw new Error(
        typeof error === 'string' ? error : '原生服务操作失败，请重试',
        { cause: error },
      );
    }
  }
  async function refresh(fresh = false) {
    if (!available || stopped) return;
    if (refreshing) {
      await refreshing;
      if (!fresh || stopped) return;
    }
    if (!refreshing) refreshing = readState();
    await refreshing;
  }
  async function readState() {
    try {
      let value = await request('native_status');
      if (!validNativeState(value)) throw new Error('原生状态格式无效');
      if (value.loginPending && value.loginCode) {
        const ready = await request('native_login_poll');
        if (typeof ready !== 'boolean') throw new Error('登录状态响应无效');
        value = await request('native_status');
        if (!validNativeState(value)) throw new Error('原生状态格式无效');
      }
      update({
        available,
        state: value as NativeState,
        error: snapshot.error,
        avatar:
          identity(value as NativeState) === identity(snapshot.state)
            ? snapshot.avatar
            : null,
      });
    } catch (error) {
      update({
        ...snapshot,
        error: error instanceof Error ? error.message : '无法读取原生状态',
      });
    } finally {
      refreshing = null;
    }
  }
  const operation = async (name: string, args?: Record<string, unknown>) => {
    await request(name, args);
    update({ ...snapshot, error: '' });
    await refresh(true);
  };
  const avatar = async () => {
    const requestedIdentity = identity(snapshot.state);
    const value = await request('native_avatar');
    if (
      value !== null &&
      (!string(value) ||
        value.length > 3 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value))
    )
      throw new Error('皮肤头像响应无效');
    if (requestedIdentity === identity(snapshot.state))
      update({ ...snapshot, avatar: value as string | null });
    return value as string | null;
  };
  const saveFile = async (command: string, args: Record<string, unknown>) => {
    const value = await request(command, args);
    if (!string(value)) throw new Error('文件保存响应无效');
    return value;
  };
  const timer = available
    ? setInterval(() => {
        void refresh();
      }, 700)
    : undefined;
  return {
    planResources: async (id, kind, version, filename) => {
      const value = await request('native_resource_plan', {
        id,
        kind,
        version,
        filename,
      });
      if (!validResourcePlan(value) || value.instanceId !== id)
        throw new Error('安装计划响应无效');
      return value;
    },
    installResources: (token) =>
      operation('native_resource_install', { token }),
    searchResources: async (kind, query, gameVersion, offset) => {
      const value = await request('native_resource_search', {
        kind,
        query,
        gameVersion,
        offset,
      });
      if (
        !isRecord(value) ||
        !integer(value.total) ||
        value.total > 10_000_000 ||
        !integer(value.offset) ||
        value.offset > 10000 ||
        !Array.isArray(value.hits) ||
        value.hits.length > 20 ||
        !value.hits.every(
          (hit: unknown) =>
            isRecord(hit) &&
            resourceId(hit.id) &&
            bounded(hit.title, 512) &&
            bounded(hit.description, 4096) &&
            bounded(hit.author, 128),
        )
      )
        throw new Error('资源搜索响应无效');
      return value as ResourceSearch;
    },
    resourceDetail: async (project, kind, gameVersion) => {
      const value = await request('native_resource_detail', {
        project,
        kind,
        gameVersion,
      });
      if (!validResourceDetail(value) || value.id !== project)
        throw new Error('资源详情响应无效');
      return value;
    },
    content: async (id, kind) => {
      const value = await request('native_content', { id, kind });
      if (
        !Array.isArray(value) ||
        value.length > 1000 ||
        !value.every(
          (item) =>
            isRecord(item) &&
            string(item.file) &&
            item.file.length <= 240 &&
            string(item.name) &&
            string(item.version) &&
            typeof item.enabled === 'boolean' &&
            typeof item.editable === 'boolean' &&
            integer(item.bytes) &&
            string(item.revision) &&
            /^\d+:\d+$/.test(item.revision),
        )
      )
        throw new Error('本地内容响应无效');
      return value as ContentEntry[];
    },
    toggleContent: (id, file, revision, enabled) =>
      operation('native_content_toggle', { id, file, revision, enabled }),
    importContent: async (id, kind, file, bytes) => {
      if (bytes.length > 16 * 1024 * 1024)
        throw new Error('本地导入暂限 16 MB');
      await operation('native_content_import', { id, kind, file, bytes });
    },
    contentImage: async (id, file) => {
      const value = await request('native_content_image', { id, file });
      if (
        !string(value) ||
        value.length > 23 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)
      )
        throw new Error('截图响应无效');
      return value;
    },
    openContent: (id, kind) => operation('native_content_open', { id, kind }),
    renameInstance: (id, name) =>
      operation('native_instance_rename', { id, name }),
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    avatar,
    saveAvatar: async (bytes) => {
      if (bytes.length > 2 * 1024 * 1024) throw new Error('皮肤文件超过 2 MB');
      await request('native_avatar_save', { bytes });
      await avatar();
    },
    worlds: async (id) => {
      const value = await request('native_worlds', { id });
      if (
        !Array.isArray(value) ||
        value.length > 1000 ||
        !value.every(
          (item: unknown) =>
            isRecord(item) && string(item.id) && string(item.name),
        )
      )
        throw new Error('存档列表响应无效');
      return value as WorldEntry[];
    },
    world: async (id, worldId) => {
      const value = await request('native_world', { id, worldId });
      if (!validWorld(value)) throw new Error('世界配置响应无效');
      return value;
    },
    saveWorld: (id, worldId, settings) =>
      saveFile('native_world_save', { id, worldId, settings }),
    options: async (id) => {
      const value = await request('native_options', { id });
      if (!validOptions(value)) throw new Error('游戏选项响应无效');
      return value;
    },
    saveOptions: (id, options) =>
      saveFile('native_options_save', { id, options }),
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      listeners.clear();
    },
    versions: async () => {
      const value = await request('native_versions');
      if (
        !Array.isArray(value) ||
        !value.every((item: unknown) => isRecord(item) && string(item.id))
      )
        throw new Error('版本清单格式无效');
      return value.map((item: { id: string }) => item.id);
    },
    saveSettings: (settings) => operation('native_settings', { settings }),
    previewPack: async (bytes) => {
      if (bytes.length > 16 * 1024 * 1024)
        throw new Error('预览文件须小于 16 MB');
      const value = await request('native_pack_preview', { bytes });
      if (
        !isRecord(value) ||
        !string(value.kind) ||
        !string(value.name) ||
        !integer(value.files) ||
        !integer(value.expandedBytes) ||
        !integer(value.downloads) ||
        ![value.dependencies, value.paths, value.warnings].every(
          (items: unknown) => Array.isArray(items) && items.every(string),
        )
      )
        throw new Error('整合包预览响应无效');
      return value as PackPreview;
    },
    optimizeMemory: async (system = false) => {
      const value = await request('native_memory_optimize', { system });
      if (!validMemory(value)) throw new Error('内存检测响应无效');
      return value;
    },
    fabricVersions: async (version) => {
      const value = await request('native_fabric_versions', { version });
      if (
        !Array.isArray(value) ||
        !value.every(
          (item: unknown) =>
            string(item) && /^[A-Za-z0-9._+-]{1,100}$/.test(item),
        )
      )
        throw new Error('Fabric 版本响应无效');
      return value as string[];
    },
    memory: async () => {
      const value = await request('native_memory');
      if (!validMemory(value)) throw new Error('内存检测响应无效');
      return value;
    },
    probeJava: async (path) => {
      const value = await request('native_java', { path });
      if (
        !isRecord(value) ||
        !integer(value.major) ||
        typeof value.is64Bit !== 'boolean' ||
        !string(value.path)
      )
        throw new Error('Java 检测响应无效');
      return value as JavaInfo;
    },
    beginLogin: async () => {
      const value = await request('native_login_begin');
      if (
        !isRecord(value) ||
        !string(value.userCode) ||
        !integer(value.interval) ||
        value.interval < 1 ||
        !integer(value.expiresIn)
      )
        throw new Error('设备码响应无效');
      await refresh();
      return value as DeviceCode;
    },
    pollLogin: async () => {
      const value = await request('native_login_poll');
      if (typeof value !== 'boolean') throw new Error('登录状态响应无效');
      await refresh();
      return value;
    },
    cancelLogin: () => operation('native_login_cancel'),
    openLogin: () => operation('native_open_login'),
    signOut: () => operation('native_sign_out'),
    install: (version, name, fabricVersion) =>
      operation('native_install', { version, name, fabricVersion }),
    launch: (id) => operation('native_launch', { id }),
    cancel: () => operation('native_cancel'),
  };
}
