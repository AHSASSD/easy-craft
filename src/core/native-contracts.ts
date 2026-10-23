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
};
export type MemoryInfo = {
  totalMb: number;
  availableMb: number;
  recommendedMb: number;
  reserveMb: number;
};
export interface NativeService extends Observable<NativeSnapshot> {
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
  versions(): Promise<string[]>;
  previewPack(bytes: number[]): Promise<PackPreview>;
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
