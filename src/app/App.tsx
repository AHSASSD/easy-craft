import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
} from 'react';
import {
  ArrowRight,
  Box,
  ChevronRight,
  Code2,
  Download,
  FolderClosed,
  Home,
  Leaf,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  UserRound,
  X,
} from 'lucide-react';
import { loaders, type GameInstance, type LoaderKind } from '../core/contracts';
import { services, warnings } from './runtime';
import { Modal } from '../components/Modal';
import { Titlebar } from '../components/Titlebar';
import '../themes/app.css';

type Page = '首页' | '实例详情' | '下载中心' | '设置' | '开发者工具';
type Dialog =
  | { kind: 'account' | 'add' }
  | { kind: 'menu' | 'rename'; instance: GameInstance }
  | null;
const loaderLabel = (loader: LoaderKind) =>
  loader === 'vanilla' ? '原版' : loader[0].toUpperCase() + loader.slice(1);
const statusLabel = {
  ready: '演示就绪',
  missing: '演示缺失状态',
  installing: '演示准备中',
  broken: '演示异常状态',
};

export function App() {
  const preferences = useSyncExternalStore(
    services.preferences.subscribe,
    services.preferences.snapshot,
  );
  const instances = useSyncExternalStore(
    services.instances.subscribe,
    services.instances.snapshot,
  );
  const [page, setPage] = useState<Page>('首页');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState(warnings.at(-1) ?? '');
  const [collapsed, setCollapsed] = useState(false);
  const [background, setBackground] = useState('');
  const dragging = useRef<number | null>(null);
  const selected =
    instances.find((instance) => instance.id === preferences.selectedId) ??
    instances[0];
  const report = (message: string) => setNotice(message);
  const attempt = (operation: () => void) => {
    try {
      operation();
    } catch (error) {
      report(error instanceof Error ? error.message : '操作失败');
    }
  };
  const visible = instances
    .filter((instance) =>
      `${instance.name} ${instance.minecraftVersion} ${instance.loader}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (preferences.sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '')),
    );
  useEffect(() => {
    const warning = () => setNotice(warnings.at(-1) ?? '');
    window.addEventListener('easycraft-warning', warning);
    return () => window.removeEventListener('easycraft-warning', warning);
  }, []);
  useEffect(
    () => () => {
      if (background) URL.revokeObjectURL(background);
    },
    [background],
  );
  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
  function select(instance: GameInstance) {
    void services.instances
      .select(instance.id)
      .catch((error: unknown) =>
        report(error instanceof Error ? error.message : '选择失败'),
      );
  }
  function launch() {
    report('模拟启动工作流将在 Milestone D 接入；当前不会启动游戏。');
  }
  function saveInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    attempt(() => {
      if (dialog?.kind === 'rename')
        services.instances.rename(dialog.instance.id, String(form.get('name')));
      else
        services.instances.add(
          String(form.get('name')),
          String(form.get('version')),
          String(form.get('loader')) as LoaderKind,
        );
      setDialog(null);
      report('演示实例资料已保存，没有创建或修改游戏文件。');
    });
  }
  const go = (next: Page) => {
    setPage(next);
    setCollapsed(true);
  };
  return (
    <div className="app" data-theme={preferences.theme}>
      <Titlebar report={report} />
      <div
        className="shell"
        style={
          {
            '--sidebar-width': `${preferences.sidebarWidth}px`,
          } as CSSProperties
        }
      >
        <aside
          className={`sidebar ${collapsed ? 'collapsed' : ''}`}
          aria-label="实例栏"
        >
          <div className="sidebar-top">
            <div className="section-label">
              我的世界{' '}
              <span>{instances.length.toString().padStart(2, '0')}</span>
            </div>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="搜索实例"
                placeholder="搜索实例或版本…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="quick-actions">
              <button onClick={() => setDialog({ kind: 'add' })}>
                <Plus size={16} />
                添加演示实例
              </button>
              <button aria-label="下载中心" onClick={() => go('下载中心')}>
                <Download size={17} />
              </button>
              <button aria-label="设置" onClick={() => go('设置')}>
                <Settings size={17} />
              </button>
            </div>
            <div className="list-toolbar">
              <span>实例列表</span>
              <select
                aria-label="实例排序"
                value={preferences.sort}
                onChange={(event) =>
                  services.preferences.update({
                    sort: event.target.value as 'name' | 'recent',
                  })
                }
              >
                <option value="recent">最近使用</option>
                <option value="name">按名称</option>
              </select>
            </div>
          </div>
          <div className="instance-list">
            {visible.length ? (
              visible.map((instance) => (
                <div
                  key={instance.id}
                  className={`instance-row ${selected?.id === instance.id ? 'selected' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    select(instance);
                    setDialog({ kind: 'menu', instance });
                  }}
                >
                  <button
                    className={`instance-select ${instance.loader}`}
                    aria-pressed={selected?.id === instance.id}
                    onClick={() => select(instance)}
                    onDoubleClick={() => {
                      if (preferences.doubleClickLaunch) launch();
                    }}
                  >
                    <span className="instance-icon">
                      <Box size={22} />
                    </span>
                    <span>
                      <strong>{instance.name}</strong>
                      <small>
                        {instance.minecraftVersion} ·{' '}
                        {loaderLabel(instance.loader)}
                      </small>
                    </span>
                  </button>
                  <button
                    className={`favorite ${instance.favorite ? 'active' : ''}`}
                    aria-label={`${instance.favorite ? '取消收藏' : '收藏'} ${instance.name}`}
                    onClick={() =>
                      attempt(() => services.instances.favorite(instance.id))
                    }
                  >
                    <Star
                      size={14}
                      fill={instance.favorite ? 'currentColor' : 'none'}
                    />
                  </button>
                  <button
                    className="instance-menu"
                    aria-label={`${instance.name} 操作`}
                    onClick={() => setDialog({ kind: 'menu', instance })}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty">
                <Search size={28} />
                <strong>
                  {instances.length ? '没有匹配的实例' : '从一个新世界开始'}
                </strong>
                <p>
                  {instances.length
                    ? '换个名称或版本试试。'
                    : '添加一个演示实例，探索启动器。'}
                </p>
                <button
                  onClick={() =>
                    instances.length ? setQuery('') : setDialog({ kind: 'add' })
                  }
                >
                  {instances.length ? '清除搜索' : '添加演示实例'}
                </button>
              </div>
            )}
          </div>
          <div className="sidebar-bottom">
            <button
              className="account"
              onClick={() => setDialog({ kind: 'account' })}
            >
              <span className="avatar">
                <UserRound size={19} />
              </span>
              <span>
                <strong>访客玩家</strong>
                <small>虚构账户 · 未登录</small>
              </span>
              <ChevronRight size={16} />
            </button>
            <div className="launch-selection">
              <span>当前实例</span>
              <strong>{selected?.name ?? '尚未选择'}</strong>
            </div>
            <button className="launch" disabled={!selected} onClick={launch}>
              <Play size={18} fill="currentColor" />
              模拟启动<span>DEMO</span>
            </button>
            <small className="safe-note">仅演示流程，不会运行 Minecraft</small>
          </div>
        </aside>
        <div
          className="divider"
          role="separator"
          aria-label="调整实例栏宽度"
          aria-orientation="vertical"
          aria-valuenow={preferences.sidebarWidth}
          aria-valuemin={240}
          aria-valuemax={420}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              services.preferences.update({
                sidebarWidth: Math.min(
                  420,
                  Math.max(
                    240,
                    preferences.sidebarWidth +
                      (event.key === 'ArrowRight' ? 10 : -10),
                  ),
                ),
              });
            }
          }}
          onPointerDown={(event) => {
            dragging.current = event.clientX;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragging.current !== null) {
              const delta = event.clientX - dragging.current;
              dragging.current = event.clientX;
              services.preferences.update({
                sidebarWidth: Math.max(
                  240,
                  Math.min(420, preferences.sidebarWidth + delta),
                ),
              });
            }
          }}
          onPointerUp={() => {
            dragging.current = null;
          }}
          onPointerCancel={() => {
            dragging.current = null;
          }}
        />
        <main className="workspace">
          <nav className="navigation" aria-label="主导航">
            <button
              className="sidebar-toggle"
              aria-label="展开或折叠实例栏"
              onClick={() => setCollapsed(!collapsed)}
            >
              <Menu size={19} />
            </button>
            {(
              [
                { name: '首页', icon: Home },
                { name: '实例详情', icon: SlidersHorizontal },
                { name: '下载中心', icon: Download },
                { name: '设置', icon: Settings },
                ...(preferences.developerEnabled
                  ? [{ name: '开发者工具', icon: Code2 }]
                  : []),
              ] as const
            ).map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={page === name ? 'current' : ''}
                onClick={() => setPage(name as Page)}
              >
                <Icon size={16} />
                <span>{name}</span>
              </button>
            ))}
          </nav>
          <div className="page-content">
            {notice && (
              <div className="notice" role="status">
                <span>{notice}</span>
                <button aria-label="关闭提示" onClick={() => setNotice('')}>
                  <X size={15} />
                </button>
              </div>
            )}
            {page === '首页' && (
              <>
                <div className="eyebrow">
                  <span className="status-dot" />
                  YOUR NEXT ADVENTURE
                </div>
                <div className="page-heading">
                  <div>
                    <h1>世界很大，轻松出发。</h1>
                    <p>把复杂留在身后，把冒险握在手中。</p>
                  </div>
                  <Leaf className="heading-leaf" size={25} />
                </div>
                <section
                  className={`hero ${background ? 'custom-background' : ''}`}
                  style={
                    background
                      ? {
                          backgroundImage: `linear-gradient(90deg, rgba(12,38,31,.9), rgba(12,38,31,.25)), url("${background}")`,
                        }
                      : undefined
                  }
                >
                  <div className="terrain terrain-back" />
                  <div className="terrain terrain-front" />
                  <div className="sun" />
                  <div className="hero-content">
                    <span className="hero-tag">EASY CRAFT / 新的起点</span>
                    <h2>
                      你的世界，
                      <br />
                      由你定义。
                    </h2>
                    <p>一个简洁、自由、属于你的启动器。</p>
                    <button onClick={() => setPage('实例详情')}>
                      探索当前实例
                      <ArrowRight size={16} />
                    </button>
                  </div>
                  <span className="hero-caption">
                    原创几何地形 · 可在设置替换背景
                  </span>
                </section>
                <div className="section-heading">
                  <h2>准备好出发了吗？</h2>
                  <button
                    className="text-button"
                    onClick={() => setPage('实例详情')}
                  >
                    管理实例
                    <ArrowRight size={14} />
                  </button>
                </div>
                {selected ? (
                  <section className="summary-card">
                    <span className="large-cube">
                      <Box size={34} />
                    </span>
                    <div className="summary-info">
                      <span className="eyebrow">当前选中</span>
                      <h3>{selected.name}</h3>
                      <p>
                        <span>{selected.minecraftVersion}</span>
                        <span>{loaderLabel(selected.loader)}</span>
                        <span className="ready">
                          <i />
                          {statusLabel[selected.status]}
                        </span>
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="查看当前实例详情"
                      onClick={() => setPage('实例详情')}
                    >
                      <ChevronRight />
                    </button>
                  </section>
                ) : (
                  <div className="card empty">
                    还没有实例，点击左侧添加演示实例。
                  </div>
                )}
                <section className="activity">
                  <div className="section-heading">
                    <h2>最近活动</h2>
                    <span className="muted">本地 · 演示数据</span>
                  </div>
                  <div className="activity-row">
                    <span className="activity-dot" />
                    <div>
                      <strong>Easy Craft 已就绪</strong>
                      <p>
                        选择实例，体验主题与启动流程。此版本不会安装或运行游戏。
                      </p>
                    </div>
                    <span>V0.1</span>
                  </div>
                </section>
                <footer>
                  少一点繁琐，多一点探索。<span>Easy Craft · Phase 0</span>
                </footer>
              </>
            )}
            {page === '实例详情' && (
              <>
                <div className="eyebrow">INSTANCE / 独立世界</div>
                <h1>实例详情</h1>
                {selected ? (
                  <section className="card">
                    <div className="detail-title">
                      <span className="large-cube">
                        <Box size={34} />
                      </span>
                      <div>
                        <h2>{selected.name}</h2>
                        <p>{statusLabel[selected.status]}</p>
                      </div>
                      <button
                        aria-label="当前实例操作"
                        onClick={() =>
                          setDialog({ kind: 'menu', instance: selected })
                        }
                      >
                        <MoreHorizontal />
                      </button>
                    </div>
                    <dl>
                      <dt>实例 ID</dt>
                      <dd>{selected.id}</dd>
                      <dt>Minecraft 版本</dt>
                      <dd>{selected.minecraftVersion}</dd>
                      <dt>加载器</dt>
                      <dd>
                        {loaderLabel(selected.loader)} {selected.loaderVersion}
                      </dd>
                      <dt>游戏目录</dt>
                      <dd>未创建（演示数据）</dd>
                      <dt>最近模拟启动</dt>
                      <dd>
                        {selected.lastPlayedAt
                          ? new Date(selected.lastPlayedAt).toLocaleString(
                              'zh-CN',
                            )
                          : '尚未体验'}
                      </dd>
                    </dl>
                    <p className="hint">
                      同一版本可以拥有多个独立实例。本轮只保存实例资料，不创建游戏文件、Mod
                      或存档。
                    </p>
                    <div className="button-row">
                      <button
                        onClick={() =>
                          setDialog({ kind: 'rename', instance: selected })
                        }
                      >
                        重命名
                      </button>
                      <button
                        onClick={() =>
                          attempt(() => {
                            services.instances.copy(selected.id);
                            report('仅复制了演示资料，没有复制游戏文件。');
                          })
                        }
                      >
                        复制实例（模拟）
                      </button>
                      <button disabled title="Phase 0 不访问游戏目录">
                        <FolderClosed size={16} />
                        打开目录（未创建）
                      </button>
                    </div>
                  </section>
                ) : (
                  <p>请先添加一个演示实例。</p>
                )}
              </>
            )}
            {page === '下载中心' && (
              <>
                <div className="eyebrow">DOWNLOAD / 未来旅程</div>
                <h1>下载中心</h1>
                <section className="card empty">
                  <Download size={42} />
                  <h2>真实下载将在后续版本开放</h2>
                  <p>V0.1 不下载 Minecraft、Java、加载器或模组。</p>
                  <p>V0.2 将优先实现可信来源下载与完整性校验。</p>
                  <button onClick={() => setPage('首页')}>返回首页</button>
                </section>
              </>
            )}
            {page === '设置' && (
              <>
                <div className="eyebrow">PREFERENCES / 随心而设</div>
                <h1>让它更像你</h1>
                <section className="card">
                  <h2>外观</h2>
                  <div className="theme-grid">
                    {services.themes.listThemes().map((theme) => (
                      <button
                        key={theme.id}
                        className={`theme-card ${preferences.theme === theme.id ? 'chosen' : ''}`}
                        aria-pressed={preferences.theme === theme.id}
                        onClick={() => services.themes.activateTheme(theme.id)}
                      >
                        <span className={`theme-preview ${theme.id}`} />
                        <strong>{theme.name}</strong>
                        <small>{theme.description}</small>
                      </button>
                    ))}
                  </div>
                  <label className="file-setting">
                    首页背景（本地预览，不上传，重启后需重新选择）
                    <input
                      aria-label="选择背景图片"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        if (
                          !['image/png', 'image/jpeg', 'image/webp'].includes(
                            file.type,
                          ) ||
                          file.size > 10 * 1024 * 1024
                        ) {
                          report(
                            '请选择不超过 10 MB 的 PNG、JPEG 或 WebP 图片。',
                          );
                          return;
                        }
                        setBackground(URL.createObjectURL(file));
                      }}
                    />
                  </label>
                  {background && (
                    <button onClick={() => setBackground('')}>
                      恢复地形背景
                    </button>
                  )}
                </section>
                <section className="card">
                  <h2>交互与开发</h2>
                  <label className="toggle-row">
                    <span>
                      <strong>双击实例模拟启动</strong>
                      <small>默认关闭，避免误操作；始终是演示模式</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={preferences.doubleClickLaunch}
                      onChange={(event) =>
                        services.preferences.update({
                          doubleClickLaunch: event.target.checked,
                        })
                      }
                    />
                  </label>
                  <label className="toggle-row">
                    <span>
                      <strong>启用开发者工具</strong>
                      <small>查看官方插件与服务，不执行外部插件</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={preferences.developerEnabled}
                      onChange={(event) =>
                        services.preferences.update({
                          developerEnabled: event.target.checked,
                        })
                      }
                    />
                  </label>
                  <p className="hint">
                    主题、栏宽、排序与选中实例保存在当前浏览器或 WebView
                    的本地存储中；不保存账户令牌。
                  </p>
                </section>
              </>
            )}
            {page === '开发者工具' && preferences.developerEnabled && (
              <>
                <div className="eyebrow">DEVELOPER / 内核观测</div>
                <h1>开发者工具</h1>
                <section className="card">
                  <p>
                    插件内核将在 Milestone C
                    接入。只允许随应用打包的可信官方模块。
                  </p>
                </section>
              </>
            )}
          </div>
        </main>
      </div>
      {dialog && (
        <Modal
          title={
            dialog.kind === 'account'
              ? '账户'
              : dialog.kind === 'add'
                ? '添加演示实例'
                : dialog.kind === 'rename'
                  ? '重命名实例'
                  : 'instance' in dialog
                    ? dialog.instance.name
                    : '实例'
          }
          onClose={() => setDialog(null)}
        >
          {dialog.kind === 'account' && (
            <div className="dialog-body">
              <UserRound size={36} />
              <h3>访客玩家</h3>
              <p>这是虚构账户占位信息，尚未登录。</p>
              <p>
                Microsoft / Xbox 正版登录将在 V0.2 实现，本轮不收集任何凭据。
              </p>
              <button onClick={() => setDialog(null)}>知道了</button>
            </div>
          )}
          {(dialog.kind === 'add' || dialog.kind === 'rename') && (
            <form onSubmit={saveInstance}>
              <p className="hint">只修改本地演示资料，不下载或安装游戏。</p>
              <label>
                实例名称
                <input
                  autoFocus
                  name="name"
                  required
                  maxLength={60}
                  defaultValue={
                    dialog.kind === 'rename' ? dialog.instance.name : ''
                  }
                  placeholder="给新世界起个名字"
                />
              </label>
              {dialog.kind === 'add' && (
                <>
                  <label>
                    Minecraft 版本
                    <input
                      name="version"
                      required
                      pattern="[0-9]+\.[0-9]+(\.[0-9]+)?"
                      defaultValue="1.21.1"
                    />
                  </label>
                  <label>
                    加载器
                    <select name="loader">
                      {loaders.map((loader) => (
                        <option key={loader} value={loader}>
                          {loaderLabel(loader)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="button-row">
                <button type="button" onClick={() => setDialog(null)}>
                  取消
                </button>
                <button className="primary" type="submit">
                  保存演示资料
                </button>
              </div>
            </form>
          )}
          {dialog.kind === 'menu' && (
            <div className="context-actions">
              <button
                onClick={() => {
                  select(dialog.instance);
                  setPage('实例详情');
                  setDialog(null);
                }}
              >
                查看详情
              </button>
              <button
                onClick={() =>
                  setDialog({ kind: 'rename', instance: dialog.instance })
                }
              >
                重命名
              </button>
              <button
                onClick={() =>
                  attempt(() => {
                    services.instances.copy(dialog.instance.id);
                    setDialog(null);
                    report('演示实例资料已复制，没有复制游戏文件。');
                  })
                }
              >
                复制实例（模拟）
              </button>
              <button disabled>打开目录（演示目录未创建）</button>
              <button disabled>删除实例（演示模式禁用）</button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
