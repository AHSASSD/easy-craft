export const sections = [
  'library',
  'settings',
  'download',
  'extensions',
] as const;
export const settingsCategories = [
  'launch',
  'appearance',
  'downloads',
  'other',
] as const;
export const downloadCategories = [
  'vanilla',
  'mod',
  'shader',
  'modpack',
  'datapack',
  'resourcepack',
] as const;
export const instanceTabs = [
  'overview',
  'mods',
  'resources',
  'worlds',
  'screenshots',
  'options',
] as const;
export type Navigation = {
  section: (typeof sections)[number];
  settingsCategory: (typeof settingsCategories)[number];
  downloadCategory: (typeof downloadCategories)[number];
  instanceTabs: Record<string, (typeof instanceTabs)[number]>;
  query: string;
  scroll: Record<string, number>;
  contentQueries?: Record<string, string>;
  resourceKinds?: Record<string, 'resourcepacks' | 'shaderpacks'>;
  datapackWorlds?: Record<string, string>;
};
export const defaultNavigation: Navigation = {
  section: 'library',
  settingsCategory: 'launch',
  downloadCategory: 'vanilla',
  instanceTabs: {},
  query: '',
  scroll: {},
};
export function validNavigation(value: unknown): value is Navigation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const nav = value as Record<string, unknown>;
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item).length <= 1000;
  return (
    sections.includes(nav.section as Navigation['section']) &&
    settingsCategories.includes(
      nav.settingsCategory as Navigation['settingsCategory'],
    ) &&
    downloadCategories.includes(
      nav.downloadCategory as Navigation['downloadCategory'],
    ) &&
    typeof nav.query === 'string' &&
    nav.query.length <= 256 &&
    (nav.datapackWorlds === undefined ||
      (record(nav.datapackWorlds) &&
        Object.entries(nav.datapackWorlds).every(
          ([id, world]) =>
            id.length <= 128 &&
            typeof world === 'string' &&
            world.length <= 255 &&
            !world.includes('/') &&
            !world.includes('\\') &&
            world !== '.' &&
            world !== '..',
        ))) &&
    (nav.contentQueries === undefined ||
      (record(nav.contentQueries) &&
        Object.entries(nav.contentQueries).every(
          ([key, query]) =>
            key.length <= 256 &&
            typeof query === 'string' &&
            query.length <= 256,
        ))) &&
    (nav.resourceKinds === undefined ||
      (record(nav.resourceKinds) &&
        Object.entries(nav.resourceKinds).every(
          ([key, kind]) =>
            key.length <= 128 &&
            (kind === 'resourcepacks' || kind === 'shaderpacks'),
        ))) &&
    record(nav.instanceTabs) &&
    Object.entries(nav.instanceTabs).every(
      ([key, tab]) =>
        key.length <= 128 &&
        instanceTabs.includes(tab as Navigation['instanceTabs'][string]),
    ) &&
    record(nav.scroll) &&
    Object.entries(nav.scroll).every(
      ([key, y]) =>
        key.length <= 256 &&
        typeof y === 'number' &&
        Number.isFinite(y) &&
        y >= 0 &&
        y <= 1e8,
    )
  );
}
