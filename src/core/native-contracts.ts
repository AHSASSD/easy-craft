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
export type NativeInstance = {
  id: string;
  name: string;
  version: string;
  manifestSha1: string;
  javaMajor: number;
  fabricVersion: string;
  fabricSha1: string;
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
  avatar(): Promise<string | null>;
  saveAvatar(bytes: number[]): Promise<void>;
  background(bytes?: number[]): Promise<string | null>;
  versions(): Promise<string[]>;
  previewPack(bytes: number[]): Promise<PackPreview>;
  pickPack(): Promise<PackPreview | null>;
  previewOnlinePack(
    project: string,
    version: string,
    filename: string,
  ): Promise<PackPreview>;
  installPack(token: string, name: string, selected: string[]): Promise<void>;
  fabricVersions(version: string): Promise<string[]>;
  saveSettings(settings: NativeSettings): Promise<void>;
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
