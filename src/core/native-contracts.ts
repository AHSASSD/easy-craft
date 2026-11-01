import type { Observable } from './contracts';
export type NativeSettings = {
  autoTranslatePacks?: boolean;
  clientId: string;
  javaPath: string;
  memoryMb: number;
  memoryMode: 'auto' | 'manual';
  optimizeMemory: boolean;
  launchMode: 'microsoft' | 'offline';
  offlineName: string;
  isolateNewInstances?: boolean;
};
export type LaunchOverrides = {
  javaVersion?: number;
  windowMode?: 'windowed' | 'fullscreen' | 'inherit';
  gameIsolation?: boolean;
  javaPath?: string;
  memory?: Pick<NativeSettings, 'memoryMode' | 'memoryMb' | 'optimizeMemory'>;
};
export type NativeInstance = {
  versionFolder?: string;
  storageRoot?: string;
  local?: {
    root: string;
    versionDirectory: string;
    gameDirectory: string;
    clientJar: string;
    sourceKey: string;
    loader: 'vanilla' | 'fabric' | 'forge' | 'neoforge';
    loaderVersion: string;
  };
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
  plannedStages?: string[];
  pendingInstance?: string | null;
  steps?: {
    outcome?: 'fallback' | null;
    phase: string;
    message: string;
    completed: number;
    total: number;
    done: boolean;
  }[];
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
  modRevision?: number;
  available: boolean;
  state: NativeState | null;
  error: string;
  avatar: string | null;
};
export type WorldEntry = { id: string; name: string };
export type ModCheck = {
  instanceId: string;
  issues: string[];
  unchecked: string[];
  details?: {
    checkedAt: number;
    scope: string;
    complete: boolean;
    scannedFiles: number;
    parsedFiles: number;
    reusedFiles: number;
    elapsedMs: number;
  };
};
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
export type BackupCleanupPlan = {
  token: string;
  instanceId: string;
  worldId: string | null;
  keep: number;
  retained: ConfigBackup[];
  remove: ConfigBackup[];
  warnings: string[];
};
export type BackupCleanupReport = {
  removed: string[];
  kept: { id: string; reason: string }[];
  warnings: string[];
  cancelled: boolean;
};
export type ConfigBackupPreview = {
  backup: ConfigBackup;
  worldId: string | null;
  revision: string;
  changes: { key: string; before: string; after: string }[];
};
export type ResourceKind =
  'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';
export type ResourceSource = 'modrinth' | 'curseforge';
export type LocalVersionCandidate = {
  contentIndexed?: boolean;
  contentRoots?: string[];
  worlds?: number;
  sourceIsolation?: boolean;
  id: string;
  name: string;
  gameVersion: string;
  loader: string;
  directory: string;
  gameDirectory: string;
  supported: boolean;
  duplicate: boolean;
  files: number;
  bytes: number;
  issues: string[];
  warnings: string[];
};
export type LocalVersionScan = {
  token: string;
  directory: string;
  candidates: LocalVersionCandidate[];
  warnings: string[];
};
export type ResourceHit = {
  downloads?: number | null;
  updated?: string | null;
  gameVersions?: string[];
  iconUrl?: string | null;
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
  gameVersions?: string[];
  published?: string | null;
  downloads?: number | null;
  versionType?: string | null;
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
  local?: boolean;
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
  preflight?: ModCheck | null;
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
export type ModDetails = {
  entry: ContentEntry;
  path: string;
  note: string;
  information: null | {
    name: string;
    version: string;
    loader: string;
    ids: string[];
    authors: string[];
    description: string;
    license: string;
    dependencies: string[];
  };
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
  language: string;
  masterVolume: number;
  musicVolume: number;
  renderDistance: number;
  fullscreen: boolean;
};
export type TranslationReport = {
  file: string;
  source: string;
  matched: string[];
  unmatched: string[];
  skippedFiles: number;
};
export type DeviceCode = {
  verificationUri?: string;
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
  neoforgeVersion?: string;
  storageRoot?: string | null;
  recommendedMemoryMb?: number | null;
  forgeVersion?: string;
  curseFiles?: [number, number][];
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
  fabricGames(): Promise<string[]>;
  fabricCatalog(
    version: string,
  ): Promise<{ versions: string[]; recommended: string | null }>;
  forgeVersions(game: string): Promise<{
    recommended: string | null;
    latest: string | null;
    versions: string[];
    gameVersions: string[];
  }>;
  downloadForge(game: string, loader: string): Promise<void>;
  installForge(game: string, name: string, loader: string): Promise<void>;
  previewModFile(id: string, file: File): Promise<ResourcePlan>;
  pickModPlan(id: string): Promise<ResourcePlan | null>;
  modCheck(id: string, force?: boolean): Promise<ModCheck>;
  saveResource(
    project: string,
    version: string,
    filename: string,
  ): Promise<boolean>;
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
    source?: ResourceSource,
    project?: string,
  ): Promise<ResourcePlan>;
  installResources(token: string, acknowledgeIssues?: boolean): Promise<void>;
  searchResources(
    kind: ResourceKind,
    query: string,
    gameVersion: string,
    offset: number,
    filters?: { category: string; index: string; source?: ResourceSource },
  ): Promise<ResourceSearch>;
  resourceCategories(kind: ResourceKind): Promise<string[]>;
  installTranslation(id: string): Promise<TranslationReport>;
  openResource(
    kind: ResourceKind,
    project: string,
    source?: ResourceSource,
  ): Promise<void>;
  resourceDetail(
    project: string,
    kind: ResourceKind,
    gameVersion: string,
    options?: { source?: ResourceSource; allVersions?: boolean },
  ): Promise<ResourceDetail>;
  content(id: string, kind: ContentKind): Promise<ContentEntry[]>;
  modDetails(id: string, file: string, revision: string): Promise<ModDetails>;
  revealMod(id: string, file: string, revision: string): Promise<void>;
  removeMod(id: string, file: string, revision: string): Promise<string>;
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
  openFolder(
    id: string,
    folder:
      | 'game'
      | 'mods'
      | 'saves'
      | 'screenshots'
      | 'resourcepacks'
      | 'shaderpacks',
  ): Promise<void>;
  renameInstance(id: string, name: string): Promise<void>;
  removeInstance(id: string, archive: boolean): Promise<string | null>;
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
  prepareBackupCleanup(
    id: string,
    keep: number,
    worldId?: string,
  ): Promise<BackupCleanupPlan>;
  clearBackupCleanup(plan: BackupCleanupPlan): Promise<BackupCleanupReport>;
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
  versionCatalog(): Promise<
    { id: string; releaseTime: string; type?: string }[]
  >;
  previewPack(bytes: number[]): Promise<PackPreview>;
  previewPackFile(file: File): Promise<PackPreview>;
  pickPack(): Promise<PackPreview | null>;
  scanLocalVersions(): Promise<LocalVersionScan | null>;
  importLocalVersions(
    token: string,
    selected: { id: string; name: string; mode?: 'reference' | 'copy' }[],
  ): Promise<void>;
  previewOnlinePack(
    project: string,
    version: string,
    filename: string,
  ): Promise<PackPreview>;
  installPack(token: string, name: string, selected: string[]): Promise<void>;
  pickPackDestination(token: string, reset?: boolean): Promise<string | null>;
  fabricVersions(version: string): Promise<string[]>;
  saveSettings(settings: NativeSettings): Promise<void>;
  saveInstanceLaunch(
    id: string,
    expected: LaunchOverrides,
    launch: LaunchOverrides,
  ): Promise<void>;
  probeJava(path: string): Promise<JavaInfo>;
  pickJava(): Promise<JavaInfo | null>;
  instanceFolderJava(id: string): Promise<JavaInfo>;
  instanceJava(id: string): Promise<JavaInfo>;
  prepareJava(id: string): Promise<JavaInfo>;
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
