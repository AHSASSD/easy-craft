import {
  createInstances,
  createPreferences,
  createThemes,
} from '../core/services';
import type { Services } from '../core/contracts';
let storage: Storage | undefined;
export const warnings: string[] = [];
try {
  storage = globalThis.localStorage;
} catch {
  warnings.push('本地存储不可用，设置仅在本次会话保存。');
}
const warn = (message: string) => {
  warnings.push(message);
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('easycraft-warning'));
};
const preferences = createPreferences(storage, warn);
export const services: Services = {
  preferences,
  instances: createInstances(preferences, storage, warn),
  themes: createThemes(preferences),
  launch: {
    simulateLaunch: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('模拟工作流将在 Milestone D 接入');
        },
      }),
    }),
  },
};
