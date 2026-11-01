import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  DeviceCode,
  JavaInfo,
  MemoryInfo,
  PackPreview,
  LocalVersionScan,
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
  ConfigBackup,
  ConfigBackupPreview,
  CacheGroup,
  CacheSummary,
  CachePlan,
  CacheReport,
  BackupCleanupPlan,
  BackupCleanupReport,
  ModCheck,
} from '../core/native-contracts';
import { isRecord } from '../core/services';
const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const resourceId = (value: unknown): value is string =>
  string(value) && /^[A-Za-z0-9]{1,64}$/.test(value);
const bounded = (value: unknown, max: number): value is string =>
  string(value) && value.length <= max;
function validDeviceCode(value: unknown): value is DeviceCode {
  return (
    isRecord(value) &&
    bounded(value.userCode, 64) &&
    value.userCode.length > 0 &&
    integer(value.interval) &&
    value.interval >= 1 &&
    value.interval <= 60 &&
    integer(value.expiresIn) &&
    value.expiresIn <= 1800 &&
    (value.verificationUri === undefined ||
      [
        'https://microsoft.com/link',
        'https://www.microsoft.com/link',
        'https://microsoft.com/devicelogin',
        'https://www.microsoft.com/devicelogin',
        'https://login.microsoftonline.com/common/oauth2/deviceauth',
      ].includes(value.verificationUri as string))
  );
}
const cacheFolders: Record<CacheGroup, string> = {
  resources: 'cache/modrinth',
  packFiles: 'pack-cache',
  packArchives: 'pack-archives',
  fileInputs: 'file-inputs',
  packInputs: 'pack-inputs',
};
const cacheGroup = (value: unknown): value is CacheGroup =>
  string(value) && Object.hasOwn(cacheFolders, value);
const cacheWarnings = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 2010 &&
  value.every((message: unknown) => bounded(message, 2048));
function cachePath(group: CacheGroup, path: unknown): boolean {
  if (!bounded(path, 256) || !path.startsWith(`${cacheFolders[group]}/`))
    return false;
  const name = path.slice(cacheFolders[group].length + 1);
  return (
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..' &&
    name.length > 0
  );
}
function validBackup(value: unknown): value is ConfigBackup {
  return (
    isRecord(value) &&
    string(value.id) &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) &&
    string(value.sha1) &&
    /^[0-9a-f]{40}$/i.test(value.sha1) &&
    integer(value.bytes) &&
    value.bytes <= 16 * 1024 * 1024 &&
    integer(value.createdMs) &&
    value.createdMs <= 8640000000000000
  );
}
function validBackupCleanup(value: unknown): value is BackupCleanupPlan {
  if (
    !isRecord(value) ||
    !bounded(value.token, 36) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.token) ||
    !bounded(value.instanceId, 128) ||
    !(value.worldId === null || bounded(value.worldId, 255)) ||
    !integer(value.keep) ||
    value.keep < 1 ||
    value.keep > 100 ||
    !Array.isArray(value.retained) ||
    value.retained.length > value.keep ||
    !value.retained.every(validBackup) ||
    !Array.isArray(value.remove) ||
    !value.remove.every(validBackup) ||
    !cacheWarnings(value.warnings)
  )
    return false;
  const entries = [...value.retained, ...value.remove];
  return (
    entries.length <= 2000 &&
    new Set(entries.map((entry) => entry.id)).size === entries.length &&
    (!value.remove.length || value.retained.length === value.keep) &&
    entries.reduce((total, entry) => total + entry.bytes, 0) <=
      512 * 1024 * 1024
  );
}
function validBackupPreview(value: unknown): value is ConfigBackupPreview {
  return (
    isRecord(value) &&
    validBackup(value.backup) &&
    (value.worldId === null || bounded(value.worldId, 255)) &&
    string(value.revision) &&
    (value.revision === 'missing' || /^[0-9a-f]{40}$/i.test(value.revision)) &&
    Array.isArray(value.changes) &&
    value.changes.length <= 1100 &&
    value.changes.every(
      (change: unknown) =>
        isRecord(change) &&
        bounded(change.key, 512) &&
        bounded(change.before, 4096) &&
        bounded(change.after, 4096),
    )
  );
}
function packPreview(value: unknown): PackPreview {
  if (
    !isRecord(value) ||
    !bounded(value.kind, 64) ||
    !bounded(value.name, 200) ||
    !integer(value.files) ||
    value.files > 10000 ||
    !integer(value.expandedBytes) ||
    value.expandedBytes > 1024 * 1024 * 1024 ||
    !integer(value.downloads) ||
    value.downloads > 10000 ||
    (value.install !== undefined && !validPackPlan(value.install)) ||
    ![value.dependencies, value.paths, value.warnings].every(
      (items: unknown) =>
        Array.isArray(items) &&
        items.length <= 100 &&
        items.every((item) => bounded(item, 4096)),
    )
  )
    throw new Error('整合包预览响应无效');
  return value as PackPreview;
}
function validPackPlan(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !string(value.token) ||
    !/^[a-f0-9-]{36}$/.test(value.token) ||
    !bounded(value.name, 200) ||
    !bounded(value.packVersion, 256) ||
    !string(value.gameVersion) ||
    !/^[A-Za-z0-9._-]{1,99}$/.test(value.gameVersion) ||
    !bounded(value.fabricVersion, 100) ||
    (value.forgeVersion !== undefined && !bounded(value.forgeVersion, 100)) ||
    (value.neoforgeVersion !== undefined &&
      !bounded(value.neoforgeVersion, 100)) ||
    (value.storageRoot != null && !bounded(value.storageRoot, 32768)) ||
    (value.recommendedMemoryMb != null &&
      (!integer(value.recommendedMemoryMb) ||
        value.recommendedMemoryMb < 512 ||
        value.recommendedMemoryMb > 16384)) ||
    (value.curseFiles !== undefined &&
      (!Array.isArray(value.curseFiles) ||
        value.curseFiles.length > 1000 ||
        !value.curseFiles.every(
          (pair: unknown) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            pair.every((id: unknown) => integer(id) && id > 0),
        ))) ||
    !string(value.archiveSha512) ||
    !/^[a-f0-9]{128}$/.test(value.archiveSha512) ||
    (value.origin !== undefined &&
      (!isRecord(value.origin) ||
        !resourceId(value.origin.project) ||
        !resourceId(value.origin.version) ||
        !bounded(value.origin.filename, 512))) ||
    !Array.isArray(value.files) ||
    value.files.length > 10000
  )
    return false;
  const paths = new Set<string>();
  let total = 0;
  let optional = 0;
  return value.files.every((file: unknown) => {
    if (
      !isRecord(file) ||
      !bounded(file.path, 512) ||
      file.path.includes('\\') ||
      file.path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            /[:<>"|?*]/.test(part) ||
            Array.from(part).some(
              (character) => character.charCodeAt(0) < 32,
            ) ||
            part.toLowerCase().startsWith('.easycraft') ||
            part.toLowerCase() === 'session.lock',
        ) ||
      !integer(file.size) ||
      file.size > 512 * 1024 * 1024 ||
      !string(file.sha512) ||
      !/^[a-f0-9]{128}$/.test(file.sha512) ||
      typeof file.optional !== 'boolean' ||
      !['download', 'override', 'client-override'].includes(
        file.source as string,
      )
    )
      return false;
    const key = file.path.toLowerCase();
    if (paths.has(key)) return false;
    paths.add(key);
    total += file.size;
    if (file.optional) optional++;
    return total <= 1024 * 1024 * 1024 && optional <= 200;
  });
}
function contentEntries(value: unknown): ContentEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    !value.every(
      (item: unknown) =>
        isRecord(item) &&
        bounded(item.file, 240) &&
        bounded(item.name, 512) &&
        bounded(item.version, 256) &&
        typeof item.enabled === 'boolean' &&
        typeof item.editable === 'boolean' &&
        integer(item.bytes) &&
        bounded(item.revision, 160) &&
        /^\d+:\d+(?::\d+:\d+:\d+)?$/.test(item.revision),
    )
  )
    throw new Error('本地内容响应无效');
  return value as ContentEntry[];
}
export function validResourcePlan(value: unknown): value is ResourcePlan {
  return (
    isRecord(value) &&
    string(value.token) &&
    /^[a-f0-9-]{36}$/.test(value.token) &&
    (value.local === undefined || typeof value.local === 'boolean') &&
    bounded(value.instanceId, 128) &&
    bounded(value.gameVersion, 100) &&
    (value.worldId === undefined ||
      value.worldId === null ||
      (bounded(value.worldId, 255) &&
        value.worldId.length > 0 &&
        !/[\\/]/.test(value.worldId) &&
        !['.', '..'].includes(value.worldId))) &&
    (value.dataFormat === undefined ||
      value.dataFormat === null ||
      (Array.isArray(value.dataFormat) &&
        value.dataFormat.length === 2 &&
        value.dataFormat.every(
          (n: unknown) => integer(n) && n <= 2147483647,
        ))) &&
    Array.isArray(value.warnings) &&
    value.warnings.length <= 130 &&
    value.warnings.every((w: unknown) => bounded(w, 2048)) &&
    (value.preflight == null ||
      (isRecord(value.preflight) &&
        value.preflight.instanceId === value.instanceId &&
        cacheWarnings(value.preflight.issues) &&
        cacheWarnings(value.preflight.unchecked))) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.length <= 64 &&
    value.files.every(
      (f: unknown) =>
        isRecord(f) &&
        resourceId(f.project) &&
        resourceId(f.version) &&
        bounded(f.path, 256) &&
        /^(mods|resourcepacks|shaderpacks|datapacks)\/[^/\\]+$/.test(f.path) &&
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
    value.versions.length <= 10000 &&
    value.versions.every(
      (version: unknown) =>
        isRecord(version) &&
        resourceId(version.id) &&
        bounded(version.name, 512) &&
        bounded(version.number, 256) &&
        (version.downloads == null || integer(version.downloads)) &&
        (version.published == null || bounded(version.published, 64)) &&
        (version.versionType == null ||
          ['release', 'beta', 'alpha'].includes(
            version.versionType as string,
          )) &&
        (version.gameVersions === undefined ||
          (Array.isArray(version.gameVersions) &&
            version.gameVersions.length <= 512 &&
            version.gameVersions.every((v: unknown) => bounded(v, 128)))) &&
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
    string(value.language) &&
    /^[A-Za-z0-9_]{1,32}$/.test(value.language) &&
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
export function validLaunchOverrides(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        'javaPath',
        'javaVersion',
        'memory',
        'gameIsolation',
        'windowMode',
      ].includes(key),
    ) &&
    (value.javaVersion === undefined ||
      (integer(value.javaVersion) &&
        value.javaVersion > 0 &&
        value.javaVersion < 1000 &&
        typeof value.javaPath === 'string')) &&
    (value.gameIsolation === undefined ||
      typeof value.gameIsolation === 'boolean') &&
    (value.windowMode === undefined ||
      (typeof value.windowMode === 'string' &&
        ['windowed', 'fullscreen', 'inherit'].includes(value.windowMode))) &&
    (value.javaPath === undefined ||
      (string(value.javaPath) &&
        value.javaPath.trim().length > 0 &&
        value.javaPath.length <= 32768 &&
        !value.javaPath.includes('\0'))) &&
    (value.memory === undefined ||
      (isRecord(value.memory) &&
        Object.keys(value.memory).every((key) =>
          ['memoryMode', 'memoryMb', 'optimizeMemory'].includes(key),
        ) &&
        ['auto', 'manual'].includes(String(value.memory.memoryMode)) &&
        integer(value.memory.memoryMb) &&
        value.memory.memoryMb >= 512 &&
        value.memory.memoryMb <= 16384 &&
        typeof value.memory.optimizeMemory === 'boolean'))
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
    (settings.autoTranslatePacks === undefined ||
      typeof settings.autoTranslatePacks === 'boolean') &&
    (settings.isolateNewInstances === undefined ||
      typeof settings.isolateNewInstances === 'boolean') &&
    (settings.offlineName === '' ||
      /^[A-Za-z0-9_]{3,16}$/.test(settings.offlineName)) &&
    (settings.launchMode !== 'offline' || settings.offlineName !== '') &&
    (account === null ||
      (isRecord(account) &&
        string(account.id) &&
        string(account.name) &&
        string(account.xuid))) &&
    typeof value.loginPending === 'boolean' &&
    (value.loginCode === null || validDeviceCode(value.loginCode)) &&
    value.instances.every(
      (item: unknown) =>
        isRecord(item) &&
        string(item.id) &&
        string(item.name) &&
        string(item.version) &&
        string(item.manifestSha1) &&
        /^[0-9a-f]{40}$/i.test(item.manifestSha1) &&
        integer(item.javaMajor) &&
        (item.storageRoot === undefined || bounded(item.storageRoot, 32768)) &&
        (item.versionFolder === undefined ||
          (bounded(item.versionFolder, 256) &&
            /^ec-[^/\\]+$/.test(item.versionFolder))) &&
        (item.local === undefined ||
          (isRecord(item.local) &&
            bounded(item.local.root, 32768) &&
            bounded(item.local.versionDirectory, 32768) &&
            bounded(item.local.gameDirectory, 32768) &&
            bounded(item.local.clientJar, 32768) &&
            bounded(item.local.sourceKey, 64) &&
            /^[a-f0-9]{64}$/.test(item.local.sourceKey) &&
            ['vanilla', 'fabric', 'forge', 'neoforge'].includes(
              item.local.loader as string,
            ) &&
            bounded(item.local.loaderVersion, 256))) &&
        string(item.fabricVersion) &&
        string(item.fabricSha1) &&
        (item.launch === undefined || validLaunchOverrides(item.launch)) &&
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
    (task.pendingInstance == null || bounded(task.pendingInstance, 120)) &&
    (task.steps === undefined ||
      (Array.isArray(task.steps) &&
        task.steps.length <= 32 &&
        task.steps.every(
          (step: unknown) =>
            isRecord(step) &&
            bounded(step.phase, 128) &&
            bounded(step.message, 8192) &&
            integer(step.completed) &&
            integer(step.total) &&
            typeof step.done === 'boolean',
        ))) &&
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
  let releaseVersions:
    { expires: number; value: Promise<string[]> } | undefined;
  let avatarSequence = 0;
  let pendingModInstall = false;
  const modRequests = new Map<string, Promise<ModCheck>>();
  let newestModContext = '';
  let modQueue: Promise<unknown> = Promise.resolve();
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
      const modInstallFinished =
        pendingModInstall && value.task.status !== 'running';
      if (modInstallFinished) pendingModInstall = false;
      update({
        available,
        modRevision:
          (snapshot.modRevision ?? 0) +
          (modInstallFinished ||
          (snapshot.state?.task.status === 'running' &&
            value.task.status !== 'running' &&
            value.task.phase === 'resources-committed')
            ? 1
            : 0),
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
    if (name === 'native_resource_install') pendingModInstall = true;
    update({
      ...snapshot,
      error: '',
      modRevision:
        (snapshot.modRevision ?? 0) +
        (name === 'native_content_toggle' ||
        name === 'native_mod_remove' ||
        (name === 'native_content_import' && args?.kind === 'mods')
          ? 1
          : 0),
    });
    await refresh(true);
  };
  const avatar = async () => {
    const sequence = ++avatarSequence;
    const requestedIdentity = identity(snapshot.state);
    const value = await request('native_avatar');
    if (
      value !== null &&
      (!string(value) ||
        value.length > 3 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value))
    )
      throw new Error('皮肤头像响应无效');
    if (
      sequence === avatarSequence &&
      requestedIdentity === identity(snapshot.state)
    )
      update({ ...snapshot, avatar: value as string | null });
    return value as string | null;
  };
  const saveFile = async (command: string, args: Record<string, unknown>) => {
    const value = await request(command, args);
    if (!string(value)) throw new Error('文件保存响应无效');
    return value;
  };
  async function uploadFile(
    file: File,
    target:
      | { kind: 'pack' }
      | { kind: 'content'; id: string; contentKind: string }
      | { kind: 'modPreview'; id: string },
  ): Promise<unknown> {
    if (!file.size || file.size > 512 * 1024 * 1024)
      throw new Error('请选择不超过 512 MiB 的非空文件');
    let token: string | undefined;
    try {
      const value = await request('native_file_upload_begin', {
        name: file.name,
        size: file.size,
        target,
      });
      if (
        !string(value) ||
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
      )
        throw new Error('文件接收令牌无效');
      token = value;
      await refresh(true);
      const chunk = 1024 * 1024;
      for (let offset = 0; offset < file.size; offset += chunk) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + chunk).arrayBuffer(),
        );
        if (bytes.length !== Math.min(chunk, file.size - offset))
          throw new Error('文件读取长度已变化，请重新选择');
        await request('native_file_upload_chunk', {
          token,
          offset,
          bytes: Array.from(bytes),
        });
      }
      return await request(
        target.kind === 'modPreview'
          ? 'native_mod_upload_finish'
          : 'native_file_upload_finish',
        { token },
      );
    } finally {
      if (token)
        await request('native_file_upload_abort', { token }).catch(() => {});
      await refresh(true);
    }
  }
  const timer = available
    ? setInterval(() => {
        void refresh();
      }, 700)
    : undefined;
  return {
    datapacks: async (id, worldId) =>
      contentEntries(await request('native_world_datapacks', { id, worldId })),
    openDatapacks: (id, worldId) =>
      operation('native_world_datapacks_open', { id, worldId }),
    fabricGames: async () => {
      const value = await request('native_fabric_games');
      if (
        !Array.isArray(value) ||
        value.length > 10000 ||
        !value.every(
          (game) =>
            typeof game === 'string' && /^[A-Za-z0-9._-]{1,99}$/.test(game),
        )
      )
        throw new Error('Fabric 游戏版本响应无效');
      return value as string[];
    },
    fabricCatalog: async (version) => {
      const value = await request('native_fabric_catalog', { version });
      const valid = (v: unknown) =>
        typeof v === 'string' && /^[A-Za-z0-9._+-]{1,100}$/.test(v);
      if (
        !isRecord(value) ||
        !Array.isArray(value.versions) ||
        value.versions.length > 5000 ||
        !value.versions.every(valid) ||
        (value.recommended !== null && !valid(value.recommended))
      )
        throw new Error('Fabric 加载器目录无效');
      return value as { versions: string[]; recommended: string | null };
    },
    forgeVersions: async (game) => {
      const value = await request('native_forge_versions', { game });
      if (
        !isRecord(value) ||
        !Array.isArray(value.versions) ||
        value.versions.length > 5000 ||
        !value.versions.every(
          (version) =>
            typeof version === 'string' && /^\d+(\.\d+){1,4}$/.test(version),
        ) ||
        !Array.isArray(value.gameVersions) ||
        value.gameVersions.length > 5000 ||
        !value.gameVersions.every(
          (game) =>
            typeof game === 'string' && /^[A-Za-z0-9._-]{1,99}$/.test(game),
        ) ||
        ![value.recommended, value.latest].every(
          (v) =>
            v === null ||
            (typeof v === 'string' && /^\d+(\.\d+){1,4}$/.test(v)),
        )
      )
        throw new Error('Forge 版本响应无效');
      return value as {
        recommended: string | null;
        latest: string | null;
        versions: string[];
        gameVersions: string[];
      };
    },
    downloadForge: (game, loader) =>
      operation('native_forge_download', { game, loader }),
    installForge: (game, name, loader) =>
      operation('native_forge_install', { game, name, loader }),
    planResources: async (
      id,
      kind,
      version,
      filename,
      worldId,
      source,
      project,
    ) => {
      if (source === 'curseforge' && (kind !== 'mod' || worldId || !project))
        throw new Error('CurseForge 安装目标无效');
      const value = await request(
        source === 'curseforge'
          ? 'native_curseforge_plan'
          : 'native_resource_plan',
        source === 'curseforge'
          ? { id, project, version, filename }
          : {
              id,
              kind,
              version,
              filename,
              worldId: worldId ?? null,
            },
      );
      if (
        !validResourcePlan(value) ||
        value.instanceId !== id ||
        (value.worldId ?? null) !== (worldId ?? null) ||
        (kind === 'datapack' &&
          (!value.worldId ||
            !value.dataFormat ||
            !value.files.every((file) => file.path.startsWith('datapacks/'))))
      )
        throw new Error('安装计划响应无效');
      return value;
    },
    installResources: (token, acknowledgeIssues = false) =>
      operation('native_resource_install', {
        token,
        ...(acknowledgeIssues ? { acknowledgeIssues: true } : {}),
      }),
    installTranslation: async (id) => {
      try {
        const report = await request('native_translation_install', { id });
        if (
          !isRecord(report) ||
          !bounded(report.file, 128) ||
          !bounded(report.source, 256) ||
          !integer(report.skippedFiles) ||
          ![report.matched, report.unmatched].every(
            (items) =>
              Array.isArray(items) &&
              items.length <= 16000 &&
              items.every((item) => bounded(item, 128)),
          )
        )
          throw Error('汉化安装报告无效');
        return report as import('../core/native-contracts').TranslationReport;
      } finally {
        await refresh(true);
      }
    },
    openResource: (kind, project, source) =>
      operation('native_open_resource', {
        kind,
        project,
        ...(source === 'curseforge' ? { source } : {}),
      }),
    resourceCategories: async (kind) => {
      const value = await request('native_resource_categories', { kind });
      if (
        !Array.isArray(value) ||
        value.length > 2048 ||
        !value.every(
          (item: unknown) =>
            typeof item === 'string' && /^[a-zA-Z0-9+-]{1,64}$/.test(item),
        )
      )
        throw new Error('资源分类响应无效');
      return value as string[];
    },
    searchResources: async (kind, query, gameVersion, offset, filters) => {
      const value = await request('native_resource_search', {
        kind,
        query,
        gameVersion,
        offset,
        ...(filters
          ? { category: filters.category, index: filters.index }
          : {}),
        ...(filters?.source === 'curseforge' ? { source: filters.source } : {}),
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
            bounded(hit.author, 128) &&
            (hit.downloads == null || integer(hit.downloads)) &&
            (hit.updated == null || bounded(hit.updated, 64)) &&
            (hit.gameVersions === undefined ||
              (Array.isArray(hit.gameVersions) &&
                hit.gameVersions.length <= 512 &&
                hit.gameVersions.every((v: unknown) => bounded(v, 128)))) &&
            (hit.iconUrl == null ||
              (bounded(hit.iconUrl, 2048) &&
                /^https:\/\/(?:cdn\.modrinth\.com\/data|media\.forgecdn\.net)\/[A-Za-z0-9/_.%+-]+(?:\?[^\s]*)?$/.test(
                  hit.iconUrl,
                ))),
        )
      )
        throw new Error('资源搜索响应无效');
      return value as ResourceSearch;
    },
    resourceDetail: async (project, kind, gameVersion, options) => {
      const value = await request('native_resource_detail', {
        project,
        kind,
        gameVersion,
        ...(options?.allVersions ? { allVersions: true } : {}),
        ...(options?.source === 'curseforge' ? { source: options.source } : {}),
      });
      if (!validResourceDetail(value) || value.id !== project)
        throw new Error('资源详情响应无效');
      return value;
    },
    saveResource: async (project, version, filename) => {
      const result = await request('native_resource_save', {
        project,
        version,
        filename,
      });
      if (typeof result !== 'boolean') throw Error('资源保存响应无效');
      await refresh(true);
      return result;
    },
    modCheck: (id, force = false) => {
      const context = JSON.stringify([
        id,
        snapshot.modRevision,
        snapshot.state?.instances.find((item) => item.id === id),
      ]);
      const key = `${force}:${context}`;
      const pending = modRequests.get(key);
      if (pending) return pending;
      newestModContext = context;
      const promise = modQueue
        .catch(() => {})
        .then(async () => {
          if (!force && context !== newestModContext)
            throw new Error('检查已由更新的实例请求替代');
          const value = await request('native_mod_check', {
            id,
            ...(force ? { force: true } : {}),
          });
          const details = isRecord(value) ? value.details : undefined;
          if (
            !isRecord(value) ||
            value.instanceId !== id ||
            !cacheWarnings(value.issues) ||
            !cacheWarnings(value.unchecked) ||
            (details !== undefined &&
              (!isRecord(details) ||
                !integer(details.checkedAt) ||
                !bounded(details.scope, 1024) ||
                typeof details.complete !== 'boolean' ||
                ![
                  'scannedFiles',
                  'parsedFiles',
                  'reusedFiles',
                  'elapsedMs',
                ].every((key) => integer(details[key]))))
          )
            throw new Error('启动检查响应无效');
          return value as ModCheck;
        })
        .finally(() => {
          modRequests.delete(key);
        });
      modRequests.set(key, promise);
      modQueue = promise;
      return promise;
    },
    previewModFile: async (id, file) => {
      const value = await uploadFile(file, { kind: 'modPreview', id });
      if (
        !validResourcePlan(value) ||
        value.instanceId !== id ||
        !value.local ||
        !value.preflight ||
        !value.files.every((file) => file.path.startsWith('mods/'))
      )
        throw new Error('本地 Mod 预检响应无效');
      return value;
    },
    pickModPlan: async (id) => {
      const value = await request('native_mod_pick_plan', { id });
      if (value === null) return null;
      if (
        !validResourcePlan(value) ||
        value.instanceId !== id ||
        !value.local ||
        !value.preflight ||
        !value.files.every((file) => file.path.startsWith('mods/'))
      )
        throw new Error('本地 Mod 预检响应无效');
      return value;
    },
    content: async (id, kind) => {
      return contentEntries(await request('native_content', { id, kind }));
    },
    toggleContent: (id, file, revision, enabled) =>
      operation('native_content_toggle', { id, file, revision, enabled }),
    modDetails: async (id, file, revision) => {
      const value = await request('native_mod_details', { id, file, revision });
      if (
        !isRecord(value) ||
        !bounded(value.path, 32768) ||
        !bounded(value.note, 4096)
      )
        throw new Error('模组详情响应无效');
      contentEntries([value.entry]);
      const info = value.information;
      if (
        info !== null &&
        (!isRecord(info) ||
          !bounded(info.name, 1024) ||
          !bounded(info.version, 512) ||
          !bounded(info.loader, 64) ||
          !bounded(info.description, 64000) ||
          !bounded(info.license, 2048) ||
          !['ids', 'authors', 'dependencies'].every(
            (key) =>
              Array.isArray(info[key]) &&
              info[key].length <= 256 &&
              info[key].every((item: unknown) => bounded(item, 4096)),
          ))
      )
        throw new Error('模组声明响应无效');
      return value as import('../core/native-contracts').ModDetails;
    },
    revealMod: (id, file, revision) =>
      operation('native_mod_reveal', { id, file, revision }),
    removeMod: async (id, file, revision) => {
      const location = await request('native_mod_remove', {
        id,
        file,
        revision,
      });
      if (!bounded(location, 32768)) throw new Error('模组回收位置响应无效');
      update({ ...snapshot, modRevision: (snapshot.modRevision ?? 0) + 1 });
      await refresh(true);
      return location as string;
    },
    importContent: async (id, kind, file, bytes) => {
      if (bytes.length > 16 * 1024 * 1024)
        throw new Error('本地导入暂限 16 MB');
      await operation('native_content_import', { id, kind, file, bytes });
    },
    importContentFile: async (id, kind, file) => {
      if (
        (await uploadFile(file, { kind: 'content', id, contentKind: kind })) !==
        null
      )
        throw new Error('本地导入响应无效');
      if (kind === 'mods')
        update({ ...snapshot, modRevision: (snapshot.modRevision ?? 0) + 1 });
    },
    pickContent: async (id, kind) => {
      const value = await request('native_content_pick', { id, kind });
      if (typeof value !== 'boolean') throw new Error('本地导入响应无效');
      if (value) {
        if (kind === 'mods')
          update({ ...snapshot, modRevision: (snapshot.modRevision ?? 0) + 1 });
        await refresh(true);
      }
      return value;
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
    openFolder: (id, folder) =>
      operation('native_instance_folder_open', { id, folder }),
    renameInstance: (id, name) =>
      operation('native_instance_rename', { id, name }),
    removeInstance: async (id, archive) => {
      try {
        const value = await request('native_instance_remove', { id, archive });
        if (value !== null && !bounded(value, 32768))
          throw new Error('实例移除响应无效');
        return value as string | null;
      } finally {
        await refresh(true);
      }
    },
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    avatar,
    background: async (bytes) => {
      if (bytes && bytes.length > 10 * 1024 * 1024)
        throw new Error('背景文件超过 10 MiB');
      const value = await request(
        'native_background',
        bytes === undefined ? undefined : { bytes },
      );
      if (
        value !== null &&
        (!string(value) ||
          value.length > 14 * 1024 * 1024 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value))
      )
        throw new Error('背景响应无效');
      return value as string | null;
    },
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
    prepareBackupCleanup: async (id, keep, worldId) => {
      if (!integer(keep) || keep < 1 || keep > 100)
        throw new Error('保留数量须为 1–100');
      try {
        const value = await request('native_backup_cleanup_prepare', {
          id,
          keep,
          worldId: worldId ?? null,
        });
        if (
          !validBackupCleanup(value) ||
          value.instanceId !== id ||
          value.worldId !== (worldId ?? null) ||
          value.keep !== keep
        )
          throw new Error('备份清理预览目标或响应无效');
        return value;
      } finally {
        await refresh(true);
      }
    },
    clearBackupCleanup: async (plan) => {
      if (!validBackupCleanup(plan)) throw new Error('备份清理预览无效');
      try {
        const value = await request('native_backup_cleanup_clear', {
          token: plan.token,
        });
        if (
          !isRecord(value) ||
          !Array.isArray(value.removed) ||
          !value.removed.every(string) ||
          !Array.isArray(value.kept) ||
          !value.kept.every(
            (item: unknown) =>
              isRecord(item) && string(item.id) && bounded(item.reason, 2048),
          ) ||
          !cacheWarnings(value.warnings) ||
          typeof value.cancelled !== 'boolean'
        )
          throw new Error('备份清理结果响应无效');
        const ids = [
          ...value.removed,
          ...value.kept.map((item: { id: string }) => item.id),
        ];
        if (
          ids.length !== plan.remove.length ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => plan.remove.some((entry) => entry.id === id))
        )
          throw new Error('备份清理结果超出预览范围');
        return value as BackupCleanupReport;
      } finally {
        await refresh(true);
      }
    },
    configBackups: async (id, worldId) => {
      const value = await request('native_config_backups', {
        id,
        worldId: worldId ?? null,
      });
      if (
        !isRecord(value) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 2000 ||
        !value.entries.every(validBackup) ||
        new Set(value.entries.map((entry) => entry.id)).size !==
          value.entries.length ||
        !Array.isArray(value.warnings) ||
        value.warnings.length > 10 ||
        !value.warnings.every((warning: unknown) => bounded(warning, 2000))
      )
        throw new Error('配置备份列表响应无效');
      return { entries: value.entries, warnings: value.warnings as string[] };
    },
    previewConfigBackup: async (id, backupId, worldId) => {
      const value = await request('native_config_backup_preview', {
        id,
        backupId,
        worldId: worldId ?? null,
      });
      if (
        !validBackupPreview(value) ||
        value.backup.id !== backupId ||
        value.worldId !== (worldId ?? null)
      )
        throw new Error('配置恢复预览目标或响应无效');
      return value;
    },
    restoreConfigBackup: (id, preview) => {
      if (!validBackupPreview(preview))
        return Promise.reject(new Error('配置恢复预览无效'));
      return saveFile('native_config_backup_restore', {
        id,
        worldId: preview.worldId,
        backupId: preview.backup.id,
        revision: preview.revision,
        backupSha1: preview.backup.sha1,
      });
    },
    stop: () => {
      stopped = true;
      releaseVersions = undefined;
      if (timer) clearInterval(timer);
      listeners.clear();
    },
    versionCatalog: async () => {
      const value = await request('native_version_catalog');
      if (
        !Array.isArray(value) ||
        value.length > 5000 ||
        !value.every(
          (item: unknown) =>
            isRecord(item) &&
            bounded(item.id, 100) &&
            /^[A-Za-z0-9._-]+$/.test(item.id) &&
            (item.type === undefined ||
              ['release', 'snapshot', 'old_beta', 'old_alpha'].includes(
                item.type as string,
              )) &&
            (item.releaseTime === undefined || bounded(item.releaseTime, 64)),
        )
      )
        throw new Error('版本清单格式无效');
      return value.map(
        (item: { id: string; releaseTime?: string; type?: string }) => ({
          id: item.id,
          type: item.type ?? 'release',
          releaseTime: item.releaseTime ?? '',
        }),
      );
    },
    versions: async () => {
      if (stopped) throw new Error('原版服务已停止');
      if (!releaseVersions || releaseVersions.expires <= Date.now()) {
        const value = (async () => {
          const rows = await request('native_versions');
          if (
            !Array.isArray(rows) ||
            rows.length > 5000 ||
            !rows.every((item: unknown) => isRecord(item) && string(item.id))
          )
            throw new Error('版本清单格式无效');
          return rows.map((item: { id: string }) => item.id);
        })();
        releaseVersions = { expires: Date.now() + 300000, value };
      }
      const cached = releaseVersions;
      try {
        return [...(await cached.value)];
      } catch (error) {
        if (releaseVersions === cached) releaseVersions = undefined;
        throw error;
      }
    },
    saveSettings: (settings) => operation('native_settings', { settings }),
    cacheSummary: async () => {
      const value = await request('native_cache_summary');
      if (
        !isRecord(value) ||
        !Array.isArray(value.groups) ||
        value.groups.length > 5 ||
        !cacheWarnings(value.warnings) ||
        !value.groups.every(
          (row: unknown) =>
            isRecord(row) &&
            cacheGroup(row.group) &&
            row.folder === cacheFolders[row.group] &&
            integer(row.files) &&
            row.files <= 20000 &&
            integer(row.bytes) &&
            row.bytes <= 20000 * 512 * 1024 * 1024 &&
            integer(row.skipped) &&
            row.skipped <= 20000,
        ) ||
        new Set(value.groups.map((row) => row.group)).size !==
          value.groups.length
      )
        throw new Error('缓存统计响应无效');
      return value as unknown as CacheSummary;
    },
    prepareCache: async (groups) => {
      try {
        if (
          !groups.length ||
          groups.length > 5 ||
          !groups.every(cacheGroup) ||
          new Set(groups).size !== groups.length
        )
          throw new Error('请选择有效的缓存分类');
        const value = await request('native_cache_prepare', { groups });
        if (
          !isRecord(value) ||
          !string(value.token) ||
          !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.token) ||
          !Array.isArray(value.files) ||
          value.files.length > 2000 ||
          !integer(value.bytes) ||
          !cacheWarnings(value.warnings) ||
          !value.files.every(
            (file: unknown) =>
              isRecord(file) &&
              cacheGroup(file.group) &&
              groups.includes(file.group) &&
              cachePath(file.group, file.path) &&
              integer(file.bytes) &&
              file.bytes <= 512 * 1024 * 1024 &&
              ['verified', 'corrupt', 'temporary'].includes(
                String(file.integrity),
              ),
          ) ||
          new Set(value.files.map((file) => file.path)).size !==
            value.files.length ||
          value.files.reduce((sum, file) => sum + file.bytes, 0) !== value.bytes
        )
          throw new Error('缓存预览目标或响应无效');
        return value as unknown as CachePlan;
      } finally {
        await refresh(true);
      }
    },
    clearCache: async (token) => {
      try {
        const value = await request('native_cache_clear', { token });
        if (
          !isRecord(value) ||
          !integer(value.removedFiles) ||
          value.removedFiles > 2000 ||
          !integer(value.removedBytes) ||
          value.removedBytes > 2000 * 512 * 1024 * 1024 ||
          typeof value.cancelled !== 'boolean' ||
          !Array.isArray(value.kept) ||
          value.kept.length + value.removedFiles > 2000 ||
          !value.kept.every(
            (file: unknown) =>
              isRecord(file) &&
              Object.keys(cacheFolders).some((group) =>
                cachePath(group as CacheGroup, file.path),
              ) &&
              bounded(file.reason, 2048),
          )
        )
          throw new Error('缓存清理报告响应无效，请重新检查实际状态');
        return value as unknown as CacheReport;
      } finally {
        await refresh(true);
      }
    },
    saveInstanceLaunch: (id, expected, launch) => {
      if (!validLaunchOverrides(expected) || !validLaunchOverrides(launch))
        return Promise.reject(new Error('实例启动配置无效'));
      return operation('native_instance_launch_settings', {
        id,
        expected,
        launch,
      });
    },
    previewPack: async (bytes) => {
      if (bytes.length > 16 * 1024 * 1024)
        throw new Error('预览文件须小于 16 MB');
      return packPreview(await request('native_pack_preview', { bytes }));
    },
    previewPackFile: async (file) =>
      packPreview(await uploadFile(file, { kind: 'pack' })),
    pickPack: async () => {
      const value = await request('native_pack_pick');
      return value === null ? null : packPreview(value);
    },
    scanLocalVersions: async () => {
      const value = await request('native_local_scan_pick');
      if (value === null) return null;
      if (
        !isRecord(value) ||
        !bounded(value.token, 100) ||
        !bounded(value.directory, 32768) ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > 256 ||
        !cacheWarnings(value.warnings) ||
        !value.candidates.every(
          (v: unknown) =>
            isRecord(v) &&
            bounded(v.id, 100) &&
            bounded(v.name, 256) &&
            bounded(v.gameVersion, 100) &&
            bounded(v.loader, 256) &&
            bounded(v.directory, 32768) &&
            bounded(v.gameDirectory, 32768) &&
            typeof v.supported === 'boolean' &&
            typeof v.duplicate === 'boolean' &&
            integer(v.files) &&
            v.files <= 19000 &&
            integer(v.bytes) &&
            (v.contentIndexed === undefined ||
              typeof v.contentIndexed === 'boolean') &&
            (v.contentRoots === undefined ||
              (Array.isArray(v.contentRoots) &&
                v.contentRoots.length <= 15 &&
                v.contentRoots.every((p: unknown) => bounded(p, 64)))) &&
            (v.worlds === undefined ||
              (integer(v.worlds) && v.worlds <= 19000)) &&
            (v.sourceIsolation === undefined ||
              typeof v.sourceIsolation === 'boolean') &&
            v.bytes <= 2 * 1024 * 1024 * 1024 &&
            cacheWarnings(v.issues) &&
            cacheWarnings(v.warnings),
        )
      )
        throw new Error('本地版本扫描响应无效');
      await refresh();
      return value as LocalVersionScan;
    },
    importLocalVersions: (token, selected) =>
      operation('native_local_import', { token, selected }),
    previewOnlinePack: async (project, version, filename) => {
      try {
        const value = packPreview(
          await request('native_pack_online', { project, version, filename }),
        );
        const origin = value.install?.origin;
        if (
          value.install &&
          (!origin ||
            origin.project !== project ||
            origin.version !== version ||
            origin.filename !== filename)
        )
          throw new Error('在线归档来源与所选项目/版本/文件不一致');
        return value;
      } finally {
        await refresh(true);
      }
    },
    installPack: (token, name, selected) =>
      operation('native_pack_install', { token, name, selected }),
    pickPackDestination: async (token, reset = false) => {
      const value = await request('native_pack_destination', { token, reset });
      if (value !== null && !bounded(value, 32768))
        throw new Error('安装目录响应无效');
      return value as string | null;
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
    pickJava: async () => {
      const value = await request('native_java_pick');
      if (value === null) return null;
      if (
        !isRecord(value) ||
        !integer(value.major) ||
        typeof value.is64Bit !== 'boolean' ||
        !string(value.path)
      )
        throw Error('Java 检测响应无效');
      return value as JavaInfo;
    },
    instanceFolderJava: async (id) => {
      const value = await request('native_java_instance_folder', { id });
      if (
        !isRecord(value) ||
        !integer(value.major) ||
        typeof value.is64Bit !== 'boolean' ||
        !string(value.path)
      )
        throw Error('Java 检测响应无效');
      return value as JavaInfo;
    },
    instanceJava: async (id) => {
      const value = await request('native_instance_java', { id });
      if (
        !isRecord(value) ||
        !integer(value.major) ||
        value.major < 1 ||
        typeof value.is64Bit !== 'boolean' ||
        !bounded(value.path, 32768) ||
        !value.path
      )
        throw Error('Java 检测响应无效');
      return value as JavaInfo;
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
    prepareJava: async (id) => {
      try {
        const value = await request('native_java_prepare', { id });
        if (
          !isRecord(value) ||
          !integer(value.major) ||
          value.major < 1 ||
          value.is64Bit !== true ||
          !bounded(value.path, 32768) ||
          !value.path
        )
          throw Error('Java 准备响应无效');
        return value as JavaInfo;
      } finally {
        await refresh(true);
      }
    },
    beginLogin: async () => {
      const value = await request('native_login_begin');
      if (!validDeviceCode(value)) throw new Error('设备码响应无效');
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
