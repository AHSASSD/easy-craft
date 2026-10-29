import { useState, useSyncExternalStore } from 'react';
import {
  Check,
  LayoutTemplate,
  Package,
  Palette,
  Puzzle,
  Search,
} from 'lucide-react';
import type { Services } from '../core/contracts';
import { kernel } from '../app/bootstrap';
import layout from '../plugins/official/layout.json';

const descriptions: Record<
  string,
  { name: string; description: string; kind: string }
> = {
  'official.layout': {
    name: '官方工作区布局',
    description: '经典双栏与紧凑布局，共用实例、账号和任务。',
    kind: '布局',
  },
  'official.themes': {
    name: '外观主题',
    description: '深板岩夜色、草方块亮色与强调色。',
    kind: '外观',
  },
  'official.vanilla': {
    name: '游戏与下载',
    description: '本地实例、游戏安装、账号和原生启动。',
    kind: '功能',
  },
  'official.instances': {
    name: '演示实例模块',
    description: '仅供演示工作区使用，不创建真实游戏实例。',
    kind: '功能',
  },
  'official.demo-launch': {
    name: '演示启动模块',
    description: '演示工作区的模拟启动流程。',
    kind: '功能',
  },
};

export function ExtensionsPanel({ services }: { services: Services }) {
  const preferences = useSyncExternalStore(
    services.preferences.subscribe,
    services.preferences.snapshot,
  );
  const [page, setPage] = useState('installed');
  const [filter, setFilter] = useState('全部');
  const installed = kernel.inspect().plugins;
  return (
    <div className="workspace-page extensions-page">
      <div className="library-page-heading">
        <div>
          <h1>扩展</h1>
          <p>让 Easy Craft 按你的习惯工作。</p>
        </div>
        <span className="subtle-badge">{installed.length} 个内置模块</span>
      </div>
      <div className="extension-tabs" aria-label="扩展分类">
        <button
          aria-pressed={page === 'installed'}
          onClick={() => setPage('installed')}
        >
          已安装
        </button>
        <button
          aria-pressed={page === 'discover'}
          onClick={() => setPage('discover')}
        >
          发现插件
        </button>
      </div>
      {page === 'installed' ? (
        <>
          <section className="card layout-choice">
            <div className="section-heading">
              <h2>
                <LayoutTemplate size={18} /> 工作区布局
              </h2>
              <span className="subtle-badge">官方</span>
            </div>
            <p>切换排版，保留当前实例与后台任务。</p>
            <div className="layout-presets">
              {Object.entries(layout.presets).map(([id, preset]) => (
                <button
                  key={id}
                  aria-pressed={(preferences.layout ?? 'default') === id}
                  onClick={() =>
                    services.preferences.update({
                      layout: id as 'default' | 'compact',
                    })
                  }
                >
                  <span className={`layout-miniature ${id}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <strong>{preset.name}</strong>
                  {(preferences.layout ?? 'default') === id && (
                    <Check size={16} />
                  )}
                </button>
              ))}
            </div>
            <button
              className="text-button"
              onClick={() =>
                services.preferences.update({
                  layout: 'default',
                  sidebarWidth: 240,
                })
              }
            >
              恢复默认布局与栏宽
            </button>
          </section>
          <div className="extension-filters" aria-label="插件类型">
            {['全部', '布局', '外观', '功能'].map((kind) => (
              <button
                key={kind}
                aria-pressed={filter === kind}
                onClick={() => setFilter(kind)}
              >
                {kind}
              </button>
            ))}
          </div>
          <div className="extension-list">
            {installed
              .filter(
                (id) => filter === '全部' || descriptions[id]?.kind === filter,
              )
              .map((id) => {
                const item = descriptions[id] ?? {
                  name: id,
                  description: '已载入模块',
                  kind: '功能',
                };
                const Icon =
                  item.kind === '布局'
                    ? LayoutTemplate
                    : item.kind === '外观'
                      ? Palette
                      : Puzzle;
                return (
                  <article className="card extension-entry" key={id}>
                    <span className="extension-icon">
                      <Icon size={24} />
                    </span>
                    <div>
                      <h2>{item.name}</h2>
                      <p>{item.description}</p>
                      <small>{item.kind} · 内置</small>
                    </div>
                    <span className="extension-enabled">
                      <Check size={14} /> 已启用
                    </span>
                  </article>
                );
              })}
          </div>
        </>
      ) : (
        <section className="card extension-discover">
          <Search size={32} />
          <h2>社区插件，敬请期待</h2>
          <p>
            目前可以使用内置模块并切换官方布局。社区目录与第三方插件安装尚未开放。
          </p>
          <button onClick={() => setPage('installed')}>
            <Package size={16} /> 查看已安装
          </button>
        </section>
      )}
    </div>
  );
}
