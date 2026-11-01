import type { NativeInstance, NativeSettings } from './native-contracts';
export function instanceIsolated(instance: NativeInstance) {
  return (
    instance.launch?.gameIsolation ??
    (instance.local ? !!instance.local.gameDirectory : true)
  );
}
export function instanceLoader(instance: NativeInstance) {
  return instance.local?.loader === 'forge'
    ? `Forge ${instance.local.loaderVersion}`
    : instance.local?.loader === 'neoforge'
      ? `NeoForge ${instance.local.loaderVersion}`
      : instance.fabricVersion
        ? `Fabric ${instance.fabricVersion}`
        : '原版';
}
export function instanceGameDirectory(
  instance: NativeInstance,
  dataRoot: string,
  isolated?: boolean,
) {
  if (instance.versionFolder) {
    let root = (instance.storageRoot ?? dataRoot)
      .replaceAll('\\', '/')
      .replace(/\/+$/, '');
    if (!root.toLowerCase().endsWith('/.minecraft')) root += '/.minecraft';
    return (isolated ?? instanceIsolated(instance))
      ? `${root}/versions/${instance.versionFolder}`
      : root;
  }
  if (instance.storageRoot) {
    return `${instance.storageRoot.replace(/\\/g, '/')}/${(isolated ?? instanceIsolated(instance)) ? `instances/${instance.id}/game` : 'shared-game'}`;
  }
  if (instance.local) {
    const path =
      isolated === undefined
        ? instance.launch?.gameIsolation === undefined
          ? instance.local.gameDirectory
          : instanceIsolated(instance)
            ? instance.local.versionDirectory
            : ''
        : isolated
          ? instance.local.versionDirectory
          : '';
    return `${instance.local.root.replace(/\\/g, '/')}${path ? `/${path}` : ''}`;
  }
  return `${dataRoot.replace(/\\/g, '/')}/${(isolated ?? instanceIsolated(instance)) ? `instances/${instance.id}/game` : 'shared-game'}`;
}

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
