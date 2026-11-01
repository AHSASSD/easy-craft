import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  Puzzle,
  Search,
  ChevronRight,
  Wrench,
  Boxes,
  Palette,
  Download,
  Plus,
  Trash2,
  ShieldCheck,
  Code,
  RefreshCw,
} from 'lucide-react';
import type { Services } from '../core/contracts';
import { Modal } from '../components/Modal';
import {
  usePlugins,
  pluginSnapshot,
  initializePlugins,
  refreshPlugins,
  managePlugin,
  appearanceBaseline,
  installedStatus,
  pluginEnabled,
  visibleEntries,
  runPlugin,
  toolDrafts,
  extensionReports,
  type PluginCategory,
  type InstalledPackage,
  type PackageManifest,
} from '../core/plugin-manager';

export type ExtensionGroupId = PluginCategory;
const groups = [
  { id: 'tools', name: '我的工具', Icon: Wrench, empty: '还没有安装独立工具' },
  {
    id: 'instance',
    name: '实例扩展',
    Icon: Boxes,
    empty: '还没有安装实例扩展',
  },
  {
    id: 'appearance',
    name: '界面外观',
    Icon: Palette,
    empty: '还没有安装外观插件',
  },
] as const;
const icons = {
  code: Code,
  shield: ShieldCheck,
  layout: Puzzle,
  theme: Palette,
  palette: Palette,
  wrench: Wrench,
  boxes: Boxes,
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
function requestImport() {
  document.getElementById('plugin-package-picker')?.click();
}

/** One installer shared by file picker, drops and future authenticated downloads. */
export function PluginHost({
  services,
  active,
  onInstalled,
}: {
  services: Services;
  active: boolean;
  onInstalled(id: string, category: PluginCategory): void;
}) {
  const [replacement, setReplacement] = useState<{
    raw: string;
    manifest: PackageManifest;
    old: InstalledPackage;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(active);
  const installedRef = useRef(onInstalled);
  useEffect(() => {
    activeRef.current = active;
    installedRef.current = onInstalled;
  }, [active, onInstalled]);
  useEffect(() => {
    void initializePlugins(services);
  }, [services]);
  useEffect(() => {
    const refresh = () => {
      if (!pluginSnapshot().busy) void refreshPlugins();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const importing = useRef(false);
  async function importFile(file: File) {
    if (importing.current) return;
    importing.current = true;
    setBusy(true);
    setError('');
    try {
      if (!isTauri()) throw Error('本地插件安装需要桌面版。');
      if (!/\.json$/i.test(file.name) || file.size > 131072 || !file.size)
        throw Error(
          '请选择不超过 128 KiB 的声明式 JSON 插件包；ZIP 和脚本运行环境尚未开放。',
        );
      const raw = await file.text();
      const manifest = await invoke<PackageManifest>('native_plugin_preview', {
        raw,
      });
      const old = pluginSnapshot().registry.packages.find(
        (p) => p.manifest.id === manifest.id,
      );
      if (old) {
        if (JSON.stringify(old.manifest) === JSON.stringify(manifest))
          throw Error('此插件已安装');
        setReplacement({ raw, manifest, old });
        return;
      }
      await managePlugin({ action: 'install', raw, expected: null });
      installedRef.current(manifest.id, manifest.category);
    } catch (e) {
      setError(message(e));
    } finally {
      importing.current = false;
      setBusy(false);
    }
  }
  const importRef = useRef(importFile);
  useEffect(() => {
    importRef.current = importFile;
  });
  useEffect(() => {
    const drag = (e: DragEvent) => {
      if (activeRef.current && e.dataTransfer?.types.includes('Files'))
        e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!activeRef.current || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.files.length !== 1) {
        setError('请一次导入一个插件包');
        return;
      }
      void importRef.current(e.dataTransfer.files[0]);
    };
    window.addEventListener('dragover', drag);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragover', drag);
      window.removeEventListener('drop', drop, true);
    };
  }, []);
  return (
    <>
      <input
        id="plugin-package-picker"
        aria-label="导入本地插件"
        hidden
        type="file"
        accept=".json"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
      {error && (
        <div className="plugin-toast error" role="alert">
          <span>{error}</span>
          <button aria-label="关闭插件错误" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {replacement && (
        <Modal
          title="替换本地插件"
          onClose={() => !busy && setReplacement(null)}
        >
          <h3>{replacement.manifest.name}</h3>
          <p>
            {replacement.old.manifest.version} → {replacement.manifest.version}{' '}
            · 本地文件
          </p>
          <p>
            作者：{replacement.old.manifest.author} →{' '}
            {replacement.manifest.author}
          </p>
          <p>
            旧权限：{replacement.old.manifest.permissions.join('、') || '无'}
            <br />
            新权限：{replacement.manifest.permissions.join('、') || '无'}
          </p>
          <p>配置与成果保留；兼容或依赖校验失败时继续使用旧版。</p>
          <div className="button-row">
            <button disabled={busy} onClick={() => setReplacement(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void managePlugin({
                  action: 'install',
                  raw: replacement.raw,
                  expected: replacement.old.sha512,
                })
                  .then(() => {
                    installedRef.current(
                      replacement.manifest.id,
                      replacement.manifest.category,
                    );
                    setReplacement(null);
                  })
                  .catch((e) => setError(message(e)))
                  .finally(() => setBusy(false));
              }}
            >
              确认替换
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function ExtensionsSidebar({
  selected,
  onSelect,
  expanded,
  onExpand,
}: {
  selected: string;
  onSelect(id: string): void;
  expanded: ExtensionGroupId | null;
  onExpand(id: ExtensionGroupId | null): void;
}) {
  const store = usePlugins();
  const [query, setQuery] = useState('');
  const matches = store.registry.packages.filter((p) =>
    `${p.manifest.name} ${p.manifest.id} ${p.manifest.author}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const visibleGroup =
    query.trim() && matches.length ? matches[0].manifest.category : expanded;
  return (
    <div className="plugin-library-sidebar">
      <div className="library-list-heading">
        <h2>扩展</h2>
        <button
          aria-label="刷新插件"
          title="刷新插件目录"
          disabled={store.busy}
          onClick={() => void refreshPlugins()}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <label className="library-search sidebar-search">
        <Search size={16} />
        <input
          aria-label="搜索插件"
          placeholder="搜索工具或插件"
          maxLength={256}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="extension-groups" aria-label="扩展分类">
        {groups.map(({ id, name, Icon, empty }) => {
          const open = visibleGroup === id;
          const children = matches.filter((p) => p.manifest.category === id);
          return (
            <section key={id} className="extension-group" data-open={open}>
              <h3>
                <button
                  data-group-heading
                  type="button"
                  aria-expanded={open}
                  aria-controls={`extension-group-${id}`}
                  onClick={() => {
                    setQuery('');
                    onExpand(open ? null : id);
                  }}
                  onKeyDown={(e) => {
                    if (
                      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)
                    )
                      return;
                    e.preventDefault();
                    const buttons = Array.from(
                      e.currentTarget
                        .closest('.extension-groups')!
                        .querySelectorAll<HTMLButtonElement>(
                          '[data-group-heading]',
                        ),
                    );
                    const current = buttons.indexOf(e.currentTarget);
                    buttons[
                      e.key === 'Home'
                        ? 0
                        : e.key === 'End'
                          ? buttons.length - 1
                          : (current +
                              (e.key === 'ArrowDown' ? 1 : -1) +
                              buttons.length) %
                            buttons.length
                    ]?.focus();
                  }}
                >
                  <ChevronRight size={15} />
                  <Icon size={17} />
                  <span>{name}</span>
                  {children.length > 0 && <small>{children.length}</small>}
                </button>
              </h3>
              <div
                className="extension-group-panel"
                id={`extension-group-${id}`}
                inert={!open}
                aria-hidden={!open}
              >
                <div>
                  <div
                    className="extension-group-items plugin-library-list"
                    aria-label={`${name}列表`}
                  >
                    {children.map((p) => {
                      const m = p.manifest;
                      const ItemIcon =
                        icons[m.icon as keyof typeof icons] ?? Puzzle;
                      return (
                        <div className="library-instance-row" key={m.id}>
                          <button
                            className={`library-instance ${selected === m.id ? 'selected' : ''}`}
                            aria-pressed={selected === m.id}
                            onClick={() => onSelect(m.id)}
                          >
                            <span className="instance-block plugin-block">
                              <ItemIcon size={23} />
                            </span>
                            <span className="library-instance-name">
                              <strong title={m.name}>{m.name}</strong>
                              <small>{installedStatus(p)}</small>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        </div>
                      );
                    })}
                    {!children.length && (
                      <div className="extension-group-empty">
                        <p>
                          {!store.loaded
                            ? '读取插件…'
                            : query.trim()
                              ? '没有匹配的插件'
                              : empty}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
      <div className="library-sidebar-tools">
        <button
          className="extension-download"
          onClick={() => onSelect('discover')}
        >
          <Download size={17} />
          <span>插件下载</span>
          <ChevronRight size={15} />
        </button>
        <button
          className="extension-local-import"
          disabled={store.busy}
          onClick={requestImport}
        >
          <Plus size={17} />
          <span>本地导入</span>
        </button>
      </div>
    </div>
  );
}

class PluginBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section className="card">
        <h2>插件界面异常</h2>
        <button
          onClick={() =>
            void managePlugin({ action: 'recovery', disabled: true }).catch(
              () => {},
            )
          }
        >
          停用第三方插件
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}

export function ExtensionsPanel({
  services,
  selected,
  onSelect,
}: {
  services: Services;
  selected: string;
  onSelect(id: string): void;
}) {
  const store = usePlugins();
  const plugin = store.registry.packages.find(
    (p) => p.manifest.id === selected,
  );
  const [feedback, setFeedback] = useState('');
  return (
    <div className="workspace-page extensions-page">
      <div className="library-page-heading">
        <div>
          <h1>
            {plugin?.manifest.name ??
              (selected === 'discover' ? '插件下载' : '扩展工作区')}
          </h1>
          <p>
            {plugin?.manifest.description ??
              (selected === 'discover'
                ? '插件下载源尚未接入。'
                : '选择工具，或管理实例扩展与界面外观。')}
          </p>
        </div>
        <button
          disabled={store.busy}
          onClick={() =>
            void managePlugin({
              action: 'recovery',
              disabled: !store.safeMode,
            }).catch(() => {})
          }
        >
          {store.safeMode ? '退出恢复模式' : '停用第三方插件'}
        </button>
      </div>
      {store.safeMode && (
        <p className="notice" role="status">
          恢复模式 · 全部第三方插件已停用，原配置保留。
        </p>
      )}
      {(store.warning || store.error) && (
        <p className="notice" role="alert">
          {store.warning || store.error}
        </p>
      )}
      {feedback && (
        <div className="plugin-toast" role="status">
          <span>{feedback}</span>
          <button aria-label="关闭插件提示" onClick={() => setFeedback('')}>
            ×
          </button>
        </div>
      )}
      {plugin ? (
        <PluginBoundary key={plugin.manifest.id}>
          <PackageWorkspace
            services={services}
            plugin={plugin}
            onRemoved={() => {
              setFeedback(`${plugin.manifest.name} 已进入回收站`);
              onSelect('');
            }}
          />
        </PluginBoundary>
      ) : (
        <section className="card plugin-empty">
          <Puzzle size={30} />
          <h2>
            {selected === 'discover' ? '插件目录尚未开放' : '选择一个工具开始'}
          </h2>
          <p>
            {selected === 'discover'
              ? '当前支持本地选择或拖入声明式 JSON 插件包。'
              : '可以将插件包拖入此页安装。'}
          </p>
        </section>
      )}
    </div>
  );
}

function PackageWorkspace({
  services,
  plugin,
  onRemoved,
}: {
  services: Services;
  plugin: InstalledPackage;
  onRemoved(): void;
}) {
  const store = usePlugins();
  const m = plugin.manifest;
  const state = store.registry.states[m.id];
  const native = services.native.snapshot();
  const [instances, setInstances] = useState<string[] | null>(null);
  const [confirmation, setConfirmation] = useState<'remove' | 'disable' | null>(
    null,
  );
  const [error, setError] = useState('');
  const available = visibleEntries(plugin);
  const [entry, setEntry] = useState('');
  const current = available.find((e) => e.id === entry) ?? available[0];
  const dependents = store.registry.packages.filter((p) =>
    Object.hasOwn(p.manifest.dependencies, m.id),
  );
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    }
  };
  const enable = (enabled: boolean, ids = state?.instances ?? []) =>
    managePlugin({
      action: 'enable',
      id: m.id,
      enabled,
      instances: m.scope === 'instance' ? ids : [],
      baseline: appearanceBaseline(services.preferences.snapshot()),
    });
  const remove = () =>
    act(async () => {
      await managePlugin({
        action: 'remove',
        id: m.id,
        expected: plugin.sha512,
        acknowledge: !!confirmation,
      });
      setConfirmation(null);
      onRemoved();
    });
  return (
    <>
      <div className="plugin-actions">
        <span className="subtle-badge">已安装 · {installedStatus(plugin)}</span>
        <span className="muted">
          {m.author} · {m.version}
        </span>
        <div className="button-row">
          {m.scope === 'instance' ? (
            <button
              disabled={store.busy}
              onClick={() =>
                setInstances(
                  [...(state?.instances ?? [])].filter((id) =>
                    native.state?.instances.some((i) => i.id === id),
                  ),
                )
              }
            >
              生效实例
              {state?.instances.length ? `（${state.instances.length}）` : ''}
            </button>
          ) : (
            <label className="plugin-enable">
              <span>启用</span>
              <input
                role="switch"
                type="checkbox"
                checked={pluginEnabled(m.id)}
                disabled={store.busy || !!store.errors[m.id] || store.safeMode}
                onChange={(e) => {
                  if (
                    !e.target.checked &&
                    dependents.some(
                      (p) => store.registry.states[p.manifest.id]?.enabled,
                    )
                  )
                    setConfirmation('disable');
                  else void act(() => enable(e.target.checked));
                }}
              />
            </label>
          )}
          {m.scope === 'instance' && state?.enabled && (
            <button
              disabled={store.busy}
              onClick={() => void act(() => enable(false))}
            >
              停用
            </button>
          )}
          <button
            className="plugin-remove"
            title="移入回收站"
            disabled={store.busy}
            onClick={() => {
              if (dependents.length) setConfirmation('remove');
              else void remove();
            }}
          >
            <Trash2 size={16} />
            删除
          </button>
        </div>
      </div>
      {(error || store.errors[m.id]) && (
        <p role="alert" className="notice">
          {error || store.errors[m.id]}
        </p>
      )}
      {available.length > 1 && (
        <div className="content-subtabs" aria-label="插件工作区入口">
          {available.map((e) => (
            <button
              aria-pressed={e.id === current?.id}
              key={e.id}
              onClick={() => setEntry(e.id)}
            >
              {e.label}
            </button>
          ))}
        </div>
      )}
      {current?.capability === 'tool.json' ? (
        <JsonTool id={m.id} services={services} />
      ) : current?.capability === 'instance.mod-check' ? (
        <section className="card">
          <h2>实例模组声明检查</h2>
          <p>在“生效实例”中选择范围后，从对应实例的扩展入口运行只读检查。</p>
        </section>
      ) : (
        <AppearanceConfiguration key={`${m.id}:${m.version}`} plugin={plugin} />
      )}
      <details className="card plugin-metadata">
        <summary>配置与入口</summary>
        <dl>
          <div>
            <dt>标识</dt>
            <dd>{m.id}</dd>
          </div>
          <div>
            <dt>权限</dt>
            <dd>{m.permissions.join('、') || '无额外权限'}</dd>
          </div>
          <div>
            <dt>安装包</dt>
            <dd>{plugin.file}</dd>
          </div>
          <div>
            <dt>依赖</dt>
            <dd>
              {Object.entries(m.dependencies)
                .map(([id, v]) => `${id} ${v}`)
                .join('、') || '无'}
            </dd>
          </div>
          <div>
            <dt>冲突 / 独占位置</dt>
            <dd>{[...m.conflicts, ...m.exclusiveSlots].join('、') || '无'}</dd>
          </div>
          {m.updateSource && (
            <div>
              <dt>更新来源</dt>
              <dd>{m.updateSource}（在线更新尚未接入）</dd>
            </div>
          )}
        </dl>
        {m.entries.map((e, index) => {
          const pref = state?.entries[e.id] ?? {
            hidden: false,
            pinned: false,
            order: index,
          };
          return (
            <div className="plugin-entry-settings" key={e.id}>
              <strong>{e.label}</strong>
              <label>
                <input
                  type="checkbox"
                  checked={!pref.hidden}
                  disabled={store.busy}
                  onChange={(event) =>
                    void act(() =>
                      managePlugin({
                        action: 'entries',
                        id: m.id,
                        entries: {
                          ...state?.entries,
                          [e.id]: { ...pref, hidden: !event.target.checked },
                        },
                      }),
                    )
                  }
                />
                显示
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={pref.pinned}
                  disabled={store.busy}
                  onChange={(event) =>
                    void act(() =>
                      managePlugin({
                        action: 'entries',
                        id: m.id,
                        entries: {
                          ...state?.entries,
                          [e.id]: { ...pref, pinned: event.target.checked },
                        },
                      }),
                    )
                  }
                />
                固定
              </label>
              <label>
                排序
                <input
                  type="number"
                  min="0"
                  max="1000"
                  defaultValue={pref.order}
                  aria-label={`${e.label}排序`}
                  onBlur={(event) => {
                    const order = Number(event.target.value);
                    if (Number.isInteger(order) && order >= 0 && order <= 1000)
                      void act(() =>
                        managePlugin({
                          action: 'entries',
                          id: m.id,
                          entries: {
                            ...state?.entries,
                            [e.id]: { ...pref, order },
                          },
                        }),
                      );
                  }}
                />
              </label>
            </div>
          );
        })}
      </details>
      {instances && (
        <Modal title="选择生效实例" onClose={() => setInstances(null)}>
          <div className="plugin-instance-choices">
            {native.state?.instances.map((i) => (
              <label key={i.id}>
                <input
                  type="checkbox"
                  checked={instances.includes(i.id)}
                  onChange={(e) =>
                    setInstances(
                      e.target.checked
                        ? [...instances, i.id]
                        : instances.filter((x) => x !== i.id),
                    )
                  }
                />
                <span>
                  {i.name}
                  <small>Minecraft {i.version}</small>
                </span>
              </label>
            ))}
            {!native.state?.instances.length && <p>还没有游戏实例</p>}
          </div>
          <div className="button-row">
            <button onClick={() => setInstances(null)}>取消</button>
            <button
              disabled={store.busy}
              className="primary"
              onClick={() =>
                void act(async () => {
                  await enable(instances.length > 0, instances);
                  setInstances(null);
                })
              }
            >
              应用范围
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation === 'remove' ? '删除被依赖的插件' : '停用被依赖的插件'
          }
          onClose={() => setConfirmation(null)}
        >
          <p>
            以下插件依赖“{m.name}”：
            {dependents.map((p) => p.manifest.name).join('、')}。
          </p>
          <p>
            {confirmation === 'remove'
              ? '删除时同时停用相关插件；它们的设置与成果保留。'
              : '请先停用这些依赖方，再停用此插件。'}
          </p>
          <div className="button-row">
            <button onClick={() => setConfirmation(null)}>返回</button>
            {confirmation === 'remove' && (
              <button disabled={store.busy} onClick={() => void remove()}>
                停用相关插件并移入回收站
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function JsonTool({ id, services }: { id: string; services: Services }) {
  const store = usePlugins();
  const [input, setInput] = useState(toolDrafts.get(id)?.input ?? '');
  const draft = toolDrafts.get(id);
  return (
    <section className="card plugin-json">
      <div className="library-page-heading">
        <h2>JSON 格式化</h2>
        <button
          className="primary"
          disabled={!pluginEnabled(id) || store.busy}
          onClick={() => {
            toolDrafts.set(id, {
              input,
              output: draft?.output ?? '',
              error: '',
            });
            void runPlugin(id).catch(() => {});
          }}
        >
          格式化
        </button>
        {store.running === id && (
          <button onClick={() => void services.native.cancel()}>取消</button>
        )}
      </div>
      <div className="plugin-json-editors">
        <label>
          输入
          <textarea
            aria-label="JSON 输入"
            spellCheck={false}
            value={input}
            maxLength={1048576}
            onChange={(e) => {
              setInput(e.target.value);
              toolDrafts.set(id, {
                input: e.target.value,
                output: draft?.output ?? '',
                error: '',
              });
            }}
          />
        </label>
        <label>
          结果
          <textarea
            aria-label="JSON 结果"
            spellCheck={false}
            readOnly
            value={draft?.output ?? ''}
          />
        </label>
      </div>
      {draft?.error && <p role="alert">{draft.error}</p>}
      {!pluginEnabled(id) && (
        <p className="hint">启用后可以使用，输入仅在本机处理。</p>
      )}
    </section>
  );
}

function AppearanceConfiguration({ plugin }: { plugin: InstalledPackage }) {
  const store = usePlugins();
  const m = plugin.manifest;
  const [config, setConfig] = useState({
    ...m.settings,
    ...store.registry.states[m.id]?.config,
  });
  const [error, setError] = useState('');
  const theme = m.capabilities.includes('appearance.theme');
  const layout = m.capabilities.includes('appearance.layout');
  if (!theme && !layout) return null;
  return (
    <section className="card">
      <h2>预览与配置</h2>
      <div
        className={`plugin-appearance-preview ${config.theme === 'slate' ? 'dark' : ''}`}
        style={{ borderColor: String(config.accentColor ?? 'var(--accent)') }}
      >
        <aside style={{ width: Number(config.sidebarWidth ?? 260) / 3 }} />
        <div>
          <b style={{ color: String(config.accentColor ?? 'var(--accent)') }}>
            Easy Craft
          </b>
          <span>
            {layout
              ? config.layout === 'compact'
                ? '紧凑工作区'
                : '经典双栏'
              : '主题配色'}
          </span>
        </div>
      </div>
      <div className="plugin-config-grid">
        {theme && (
          <>
            <label>
              主题
              <select
                value={config.theme ?? 'slate'}
                onChange={(e) =>
                  setConfig({ ...config, theme: e.target.value })
                }
              >
                <option value="slate">深板岩夜色</option>
                <option value="grass">草方块亮色</option>
              </select>
            </label>
            <label>
              强调色
              <input
                type="color"
                value={String(config.accentColor ?? '#68b89e')}
                onChange={(e) =>
                  setConfig({ ...config, accentColor: e.target.value })
                }
              />
            </label>
          </>
        )}
        {layout && (
          <>
            <label>
              工作区排版
              <select
                value={config.layout ?? 'default'}
                onChange={(e) =>
                  setConfig({ ...config, layout: e.target.value })
                }
              >
                <option value="default">经典双栏</option>
                <option value="compact">紧凑工作区</option>
              </select>
            </label>
            <label>
              侧栏宽度
              <input
                type="number"
                min="240"
                max="420"
                value={Number(config.sidebarWidth ?? 260)}
                onChange={(e) =>
                  setConfig({ ...config, sidebarWidth: Number(e.target.value) })
                }
              />
            </label>
          </>
        )}
        <button
          disabled={store.busy}
          onClick={() =>
            void managePlugin({ action: 'configure', id: m.id, config }).catch(
              (e) => setError(message(e)),
            )
          }
        >
          保存配置
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function InstancePluginEntries({
  id,
  position,
  onOpen,
  selectedPlugin,
}: {
  id: string;
  position: 'instance-overview' | 'instance-tab';
  onOpen(plugin: string): void;
  selectedPlugin?: string;
}) {
  const store = usePlugins();
  const entries = store.registry.packages
    .filter(
      (p) =>
        p.manifest.scope === 'instance' && pluginEnabled(p.manifest.id, id),
    )
    .flatMap((p) =>
      visibleEntries(p, position).map((e) => ({
        plugin: p.manifest.id,
        entry: e,
      })),
    );
  if (!entries.length) return null;
  return (
    <div className="instance-plugin-entries" aria-label="实例扩展入口">
      {entries.map(({ plugin, entry }) => (
        <button
          key={`${plugin}:${entry.id}`}
          role={position === 'instance-tab' ? 'tab' : undefined}
          aria-selected={
            position === 'instance-tab' ? selectedPlugin === plugin : undefined
          }
          tabIndex={
            position === 'instance-tab' && selectedPlugin !== plugin ? -1 : 0
          }
          onClick={() => onOpen(plugin)}
        >
          <ShieldCheck size={16} />
          {entry.label}
        </button>
      ))}
    </div>
  );
}
export function InstancePluginWorkspace({
  plugin,
  id,
  services,
}: {
  plugin: string;
  id: string;
  services: Services;
}) {
  const store = usePlugins();
  const report = extensionReports.get(`${plugin}:${id}`);
  return (
    <section className="plugin-instance-report">
      <button
        className="primary"
        disabled={store.busy || !pluginEnabled(plugin, id)}
        onClick={() => void runPlugin(plugin, id).catch(() => {})}
      >
        检查此实例
      </button>
      {store.running === plugin && (
        <button onClick={() => void services.native.cancel()}>取消检查</button>
      )}
      {store.error && <p role="alert">{store.error}</p>}
      {report && (
        <>
          <p>
            {report.details?.complete ? '声明检查完成' : '检查未完成'} · 已检查{' '}
            {report.details?.scannedFiles ?? '未知'} 个归档 ·{' '}
            {report.issues.length} 个声明问题
          </p>
          {report.issues.map((issue, index) => (
            <p className="notice" key={index}>
              {issue}
            </p>
          ))}
          <details>
            <summary>检查范围与未检查项目</summary>
            {report.unchecked.map((s, i) => (
              <p key={i}>{s}</p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
