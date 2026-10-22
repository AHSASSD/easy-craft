import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  DeviceCode,
  JavaInfo,
  MemoryInfo,
  PackPreview,
  NativeService,
  NativeSnapshot,
  NativeState,
} from '../core/native-contracts';
import { isRecord } from '../core/services';
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
  let snapshot: NativeSnapshot = { available, state: null, error: '' };
  const listeners = new Set<() => void>();
  let stopped = false;
  let refreshing = false;
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
  async function refresh() {
    if (!available || refreshing || stopped) return;
    refreshing = true;
    try {
      let value = await request('native_status');
      if (!validNativeState(value)) throw new Error('原生状态格式无效');
      if (value.loginPending && value.loginCode) {
        const ready = await request('native_login_poll');
        if (typeof ready !== 'boolean') throw new Error('登录状态响应无效');
        value = await request('native_status');
        if (!validNativeState(value)) throw new Error('原生状态格式无效');
      }
      update({ available, state: value as NativeState, error: snapshot.error });
    } catch (error) {
      update({
        ...snapshot,
        error: error instanceof Error ? error.message : '无法读取原生状态',
      });
    } finally {
      refreshing = false;
    }
  }
  const operation = async (name: string, args?: Record<string, unknown>) => {
    await request(name, args);
    update({ ...snapshot, error: '' });
    await refresh();
  };
  const timer = available
    ? setInterval(() => {
        void refresh();
      }, 700)
    : undefined;
  return {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
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
