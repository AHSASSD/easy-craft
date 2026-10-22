import type { Observable } from '../contracts';
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function createStore<T>(
  key: string,
  initial: T,
  valid: (value: unknown) => value is T,
  storage?: StorageAdapter,
  warn: (message: string) => void = () => {},
) {
  let value = initial;
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!valid(parsed)) throw new Error('数据格式无效');
      value = parsed;
    }
  } catch {
    // Keep the original entry untouched until a successful backup exists.
    if (raw) {
      try {
        storage?.setItem(`${key}.invalid-backup`, raw);
      } catch {
        storage = undefined;
      }
    }
    warn('本地数据无法读取，已使用默认值；原始数据保留。');
  }
  const listeners = new Set<() => void>();
  const observable: Observable<T> = {
    snapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    ...observable,
    set(next: T) {
      if (!valid(next)) throw new Error('数据格式无效，未保存');
      try {
        storage?.setItem(key, JSON.stringify(next));
      } catch {
        warn('无法写入本地存储，本次更改仅在当前窗口有效。');
      }
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}
