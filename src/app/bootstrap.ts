import { createPreferences } from '../core/services';
import { PluginManager } from '../core/plugins/kernel';
import { officialPlugins } from '../plugins/official';
import type { Services } from '../core/contracts';
export const warnings: string[] = [];
let storage: Storage | undefined;
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
export const kernel = new PluginManager(preferences);
export async function bootstrap(): Promise<Services> {
  await kernel.load(officialPlugins(storage, warn));
  return {
    preferences,
    instances: kernel.getService('instances'),
    themes: kernel.getService('themes'),
    launch: kernel.getService('launch'),
  };
}
