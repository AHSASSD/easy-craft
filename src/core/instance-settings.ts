import type { NativeInstance, NativeSettings } from './native-contracts';

export function instanceSettings(
  global: NativeSettings,
  instance?: NativeInstance,
): NativeSettings {
  return {
    ...global,
    javaPath: instance?.launch?.javaPath ?? global.javaPath,
    ...instance?.launch?.memory,
  };
}
