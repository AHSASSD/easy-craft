import type { Observable } from './contracts';
export type NativeSettings = {
  clientId: string;
  javaPath: string;
  memoryMb: number;
  memoryMode: 'auto' | 'manual';
  optimizeMemory: boolean;
  launchMode: 'microsoft' | 'offline';
  offlineName: string;
};
export type LaunchOverrides = {
  javaPath?: string;
  memory?: Pick<NativeSettings, 'memoryMode' | 'memoryMb' | 'optimizeMemory'>;
};
export type NativeInstance = {
  id: string;
  name: string;
  version: string;
  manifestSha1: string;
  javaMajor: number;
  fabricVersion: string;
  fabricSha1: string;
  launch?: LaunchOverrides;
};
export type NativeTask = {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  message: string;
  completed: number;
  total: number;
  logs: string[];
  pid: number | null;
};
export type NativeState = {
  dataRoot: string;
  settings: NativeSettings;
  account: { id: string; name: string; xuid: string; skinUrl?: string } | null;
  instances: NativeInstance[];
  task: NativeTask;
  loginPending: boolean;
  loginCode: DeviceCode | null;
};
export type NativeSnapshot = {
  available: boolean;
  state: NativeState | null;
  error: string;
  avatar: string | null;
};
export type WorldEntry = { id: string; name: string };
export type CacheGroup =
  'resources' | 'packFiles' | 'packArchives' | 'fileInputs' | 'packInputs';
export type CacheSummary = {
  groups: {
    group: CacheGroup;
    folder: string;
    files: number;
    bytes: number;
    skipped: number;
  }[];
  warnings: string[];
};
export type CacheFile = {
  group: CacheGroup;
  path: string;
  bytes: number;
  integrity: 'verified' | 'corrupt' | 'temporary';
};
export type CachePlan = {
  token: string;
  files: CacheFile[];
  bytes: number;
  warnings: string[];
};
export type CacheReport = {
  removedFiles: number;
  removedBytes: number;
  kept: { path: string; reason: string }[];
  cancelled: boolean;
};
export type ConfigBackup = {
  id: string;
  sha1: string;
  bytes: number;
  createdMs: number;
};
export type ConfigBackupList = { entries: ConfigBackup[]; warnings: string[] };
export type ConfigBackupPreview = {
  backup: ConfigBackup;
  worldId: string | null;
  revision: string;
  changes: { key: string; before: string; after: string }[];
};
export type ResourceKind =
  'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';
export type ResourceHit = {
  id: string;
  title: string;
  description: string;
  author: string;
};
export type ResourceSearch = {
  hits: ResourceHit[];
  total: number;
  offset: number;
};
export type ResourceVersion = {
  id: string;
  name: string;
  number: string;
  environment: string;
  loaders: string[];
  files: { filename: string; size: number; sha1: string }[];
  dependencies: {
    projectId: string | null;
    versionId: string | null;
    kind: string;
  }[];
};
export type ResourceDetail = {
  id: string;
  title: string;
  description: string;
  body: string;
  versions: ResourceVersion[];
};
export type ResourcePlan = {
  token: string;
  instanceId: string;
  gameVersion: string;
  worldId?: string | null;
  dataFormat?: [number, number] | null;
  files: {
    project: string;
    version: string;
    path: string;
    size: number;
    sha512: string;
    sha1: string;
    action: 'add' | 'keep';
  }[];
  warnings: string[];
};
export type ContentKind =
  'mods' | 'resourcepacks' | 'shaderpacks' | 'screenshots';
export type ContentEntry = {
  file: string;
  name: string;
  version: string;
  enabled: boolean;
  editable: boolean;
  bytes: number;
  revision: string;
};
export type GameRule = {
  key: string;
  kind: 'boolean' | 'integer' | 'text';
  value: string;
};
export type WorldSettings = {
  revision: string;
  difficulty: number;
  difficultyLocked: boolean;
  allowCommands: boolean | null;
  hardcore: boolean;
  gameMode: number | null;
  dayTime: string | null;
  weather: 'clear' | 'rain' | 'thunder' | null;
  gameRules: GameRule[];
};
export type ClientOptions = {
  revision: string;
  masterVolume: number;
  musicVolume: number;
  renderDistance: number;
  fullscreen: boolean;
};
export type DeviceCode = {
  userCode: string;
  interval: number;
  expiresIn: number;
};
export type JavaInfo = { major: number; is64Bit: boolean; path: string };
export type PackPreview = {
  kind: string;
  name: string;
  files: number;
  expandedBytes: number;
  downloads: number;
  dependencies: string[];
  paths: string[];
  warnings: string[];
  install?: PackInstallPlan;
};
export type PackInstallPlan = {
  token: string;
  name: string;
  packVersion: string;
  gameVersion: string;
  fabricVersion: string;
  archiveSha512: string;
  origin?: { project: string; version: string; filename: string };
  files: {
    path: string;
    size: number;
    sha512: string;
    optional: boolean;
    source: 'download' | 'override' | 'client-override';
  }[];
};
export type MemoryInfo = {
  totalMb: number;
  availableMb: number;
  recommendedMb: number;
  reserveMb: number;
};
export interface NativeService extends Observable<NativeSnapshot> {
  cacheSummary(): Promise<CacheSummary>;
  prepareCache(groups: CacheGroup[]): Promise<CachePlan>;
  clearCache(token: string): Promise<CacheReport>;
  datapacks(id: string, worldId: string): Promise<ContentEntry[]>;
  openDatapacks(id: string, worldId: string): Promise<void>;
  planResources(
    id: string,
    kind: ResourceKind,
    version: string,
    filename: string,
    worldId?: string,
  ): Promise<ResourcePlan>;
  installResources(token: string): Promise<void>;
  searchResources(
    kind: ResourceKind,
    query: string,
    gameVersion: string,
    offset: number,
  ): Promise<ResourceSearch>;
  resourceDetail(
    project: string,
    kind: ResourceKind,
    gameVersion: string,
  ): Promise<ResourceDetail>;
  content(id: string, kind: ContentKind): Promise<ContentEntry[]>;
  toggleContent(
    id: string,
    file: string,
    revision: string,
    enabled: boolean,
  ): Promise<void>;
  importContent(
    id: string,
    kind: ContentKind,
    file: string,
    bytes: number[],
  ): Promise<void>;
  pickContent(id: string, kind: ContentKind): Promise<boolean>;
  importContentFile(id: string, kind: ContentKind, file: File): Promise<void>;
  contentImage(id: string, file: string): Promise<string>;
  openContent(id: string, kind?: ContentKind): Promise<void>;
  renameInstance(id: string, name: string): Promise<void>;
  refresh(fresh?: boolean): Promise<void>;
  worlds(id: string): Promise<WorldEntry[]>;
  world(id: string, worldId: string): Promise<WorldSettings>;
  saveWorld(
    id: string,
    worldId: string,
    settings: WorldSettings,
  ): Promise<string>;
  options(id: string): Promise<ClientOptions>;
  saveOptions(id: string, options: ClientOptions): Promise<string>;
  configBackups(id: string, worldId?: string): Promise<ConfigBackupList>;
  previewConfigBackup(
    id: string,
    backupId: string,
    worldId?: string,
  ): Promise<ConfigBackupPreview>;
  restoreConfigBackup(
    id: string,
    preview: ConfigBackupPreview,
  ): Promise<string>;
  avatar(): Promise<string | null>;
  saveAvatar(bytes: number[]): Promise<void>;
  background(bytes?: number[]): Promise<string | null>;
  versions(): Promise<string[]>;
  previewPack(bytes: number[]): Promise<PackPreview>;
  previewPackFile(file: File): Promise<PackPreview>;
  pickPack(): Promise<PackPreview | null>;
  previewOnlinePack(
    project: string,
    version: string,
    filename: string,
  ): Promise<PackPreview>;
  installPack(token: string, name: string, selected: string[]): Promise<void>;
  fabricVersions(version: string): Promise<string[]>;
  saveSettings(settings: NativeSettings): Promise<void>;
  saveInstanceLaunch(
    id: string,
    expected: LaunchOverrides,
    launch: LaunchOverrides,
  ): Promise<void>;
  probeJava(path: string): Promise<JavaInfo>;
  memory(): Promise<MemoryInfo>;
  optimizeMemory(system?: boolean): Promise<MemoryInfo>;
  beginLogin(): Promise<DeviceCode>;
  pollLogin(): Promise<boolean>;
  cancelLogin(): Promise<void>;
  openLogin(): Promise<void>;
  signOut(): Promise<void>;
  install(version: string, name: string, fabricVersion?: string): Promise<void>;
  launch(id: string): Promise<void>;
  cancel(): Promise<void>;
}
