import type { NativeService } from './native-contracts';
import type { Navigation } from './navigation';
export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';
export type GameInstance = {
  id: string;
  name: string;
  minecraftVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  gameDirectory?: string;
  favorite: boolean;
  lastPlayedAt?: string;
  status: 'ready' | 'missing' | 'installing' | 'broken';
};
export type Preferences = {
  theme: 'slate' | 'grass';
  sidebarWidth: number;
  selectedId: string;
  doubleClickLaunch: boolean;
  developerEnabled: boolean;
  sort: 'name' | 'recent';
  backgroundShade?: number;
  reduceMotion?: boolean;
  navigation?: Navigation;
};
export type ThemeDefinition = {
  id: Preferences['theme'];
  name: string;
  description: string;
};
export type LaunchProgress = {
  step: 'validate' | 'prepare' | 'arguments' | 'finish';
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  message: string;
  percent?: number;
};
export type Observable<T> = {
  snapshot(): T;
  subscribe(listener: () => void): () => void;
};
export interface PreferencesService extends Observable<Preferences> {
  update(patch: Partial<Preferences>): void;
}
export interface InstanceService extends Observable<GameInstance[]> {
  list(): Promise<GameInstance[]>;
  getById(id: string): Promise<GameInstance | null>;
  select(id: string): Promise<void>;
  add(name: string, version: string, loader: LoaderKind): void;
  rename(id: string, name: string): void;
  copy(id: string): void;
  favorite(id: string): void;
  markPlayed(id: string): void;
}
export interface ThemeService {
  listThemes(): ThemeDefinition[];
  activateTheme(id: Preferences['theme']): void;
}
export interface LaunchService {
  simulateLaunch(
    instanceId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LaunchProgress>;
}
export interface Services {
  preferences: PreferencesService;
  instances: InstanceService;
  themes: ThemeService;
  launch: LaunchService;
  native: NativeService;
}
export const loaders: LoaderKind[] = [
  'vanilla',
  'fabric',
  'forge',
  'neoforge',
  'quilt',
];
