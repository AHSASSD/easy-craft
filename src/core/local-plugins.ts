import type { Preferences } from './contracts';
export type LocalPlugin = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  type: 'layout' | 'theme';
  settings: Partial<
    Pick<Preferences, 'layout' | 'sidebarWidth' | 'theme' | 'accentColor'>
  >;
};
export function parseLocalPlugin(raw: string): LocalPlugin {
  if (raw.length > 131072) throw Error('插件文件超过 128 KiB');
  const p = JSON.parse(raw);
  if (
    !p ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) =>
        ![
          'schemaVersion',
          'id',
          'name',
          'version',
          'description',
          'type',
          'settings',
        ].includes(k),
    ) ||
    p.schemaVersion !== 1 ||
    typeof p.id !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{2,79}$/.test(p.id) ||
    p.id.startsWith('official.') ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 80 ||
    !/^\d+\.\d+\.\d+$/.test(p.version) ||
    !['layout', 'theme'].includes(p.type) ||
    (p.description !== undefined &&
      (typeof p.description !== 'string' || p.description.length > 1000)) ||
    !p.settings ||
    Array.isArray(p.settings) ||
    typeof p.settings !== 'object'
  )
    throw Error('无效插件：需要兼容的布局或主题 JSON 包');
  const s = p.settings;
  const allowed =
    p.type === 'layout' ? ['layout', 'sidebarWidth'] : ['theme', 'accentColor'];
  if (
    !Object.keys(s).length ||
    Object.keys(s).some((k) => !allowed.includes(k)) ||
    (s.layout !== undefined && !['default', 'compact'].includes(s.layout)) ||
    (s.sidebarWidth !== undefined &&
      (!Number.isInteger(s.sidebarWidth) ||
        s.sidebarWidth < 240 ||
        s.sidebarWidth > 420)) ||
    (s.theme !== undefined && !['slate', 'grass'].includes(s.theme)) ||
    (s.accentColor !== undefined &&
      (typeof s.accentColor !== 'string' ||
        !/^#[a-f0-9]{6}$/i.test(s.accentColor)))
  )
    throw Error('插件配置不兼容，脚本和任意页面代码暂不支持');
  return { ...p, description: p.description ?? '' };
}
