import type { Observable } from './contracts';
export type NativeSettings = {
  clientId: string;
  javaPath: string;
  memoryMb: number;
  launchMode: 'microsoft' | 'offline';
  offlineName: string;
};
export type NativeInstance = {
  id: string;
  name: string;
  version: string;
  manifestSha1: string;
  javaMajor: number;
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
  account: { id: string; name: string; xuid: string } | null;
  instances: NativeInstance[];
  task: NativeTask;
  loginPending: boolean;
  loginCode: DeviceCode | null;
};
export type NativeSnapshot = {
  available: boolean;
  state: NativeState | null;
  error: string;
};
export type DeviceCode = {
  userCode: string;
  interval: number;
  expiresIn: number;
};
export type JavaInfo = { major: number; is64Bit: boolean; path: string };
export interface NativeService extends Observable<NativeSnapshot> {
  refresh(): Promise<void>;
  versions(): Promise<string[]>;
  saveSettings(settings: NativeSettings): Promise<void>;
  probeJava(path: string): Promise<JavaInfo>;
  beginLogin(): Promise<DeviceCode>;
  pollLogin(): Promise<boolean>;
  cancelLogin(): Promise<void>;
  openLogin(): Promise<void>;
  signOut(): Promise<void>;
  install(version: string, name: string): Promise<void>;
  launch(id: string): Promise<void>;
  cancel(): Promise<void>;
}
