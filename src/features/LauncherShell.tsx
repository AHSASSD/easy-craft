import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Box,
  Download,
  Settings,
  Search,
  Plus,
  RefreshCw,
  Play,
  FolderOpen,
  ChevronRight,
  Menu,
  Globe2,
  Cpu,
  Palette,
  MoreHorizontal,
  Layers,
  Package,
  Image,
  FileCode,
} from 'lucide-react';
import type { Services } from '../core/contracts';
import { defaultNavigation, type Navigation } from '../core/navigation';
import { Titlebar } from '../components/Titlebar';
import { Modal } from '../components/Modal';
import { SkinAvatar } from '../components/SkinAvatar';
import { AccountPanel } from './AccountPanel';
import { MemoryPanel } from './MemoryPanel';
import { JavaPanel } from './JavaPanel';
import { NativeWorkspace } from './NativeWorkspace';
import { PackInspector } from './PackInspector';
import { WorldSettingsPanel } from './WorldSettingsPanel';
import { UnsavedChanges, useNavigationGuard } from './UnsavedChanges';
import landscape from '../assets/landscape.svg';
import '../themes/library.css';
import '../themes/rail.css';

const mainItems = [
  { id: 'library', name: '游戏库', icon: Box },
  { id: 'settings', name: '设置', icon: Settings },
  { id: 'download', name: '下载', icon: Download },
] as const;
const settingItems = [
  { id: 'launch', name: '启动', icon: Cpu },
  { id: 'appearance', name: '个性化', icon: Palette },
  { id: 'downloads', name: '下载设置', icon: Download },
  { id: 'other', name: '其他', icon: MoreHorizontal },
] as const;
const downloadItems = [
  { id: 'vanilla', name: '原版游戏', icon: Box },
  { id: 'mod', name: '模组', icon: Layers },
  { id: 'shader', name: '光影包', icon: Image },
  { id: 'modpack', name: '整合包', icon: Package },
  { id: 'datapack', name: '数据包', icon: FileCode },
  { id: 'resourcepack', name: '资源包', icon: FolderOpen },
] as const;

export function LauncherShell({ services }: { services: Services }) {
  return (
    <UnsavedChanges>
      <Shell services={services} />
    </UnsavedChanges>
  );
}
function Shell({ services }: { services: Services }) {
  const native = useSyncExternalStore(
    services.native.subscribe,
    services.native.snapshot,
  );
  const preferences = useSyncExternalStore(
    services.preferences.subscribe,
    services.preferences.snapshot,
  );
  const nav = preferences.navigation ?? defaultNavigation;
  const view = nav.section;
  const state = native.state;
  const selected =
    state?.instances.find((item) => item.id === preferences.selectedId) ??
    state?.instances[0];
  const tab = (selected && nav.instanceTabs[selected.id]) ?? 'overview';
  const running = state?.task.status === 'running';
  const task = state?.task;
  const identity =
    state?.settings.launchMode === 'offline'
      ? state.settings.offlineName
      : state?.account?.name;
  const canLaunch =
    !!selected &&
    !running &&
    !state?.loginPending &&
    (state?.settings.launchMode === 'offline' || !!state?.account);
  const [account, setAccount] = useState(false);
  const [notice, setNotice] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [background, setBackground] = useState('');
  const [tasks, setTasks] = useState(false);
  const [closing, setClosing] = useState(false);
  const allowClose = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const guard = useNavigationGuard();
  const location =
    view === 'library'
      ? `library:${selected?.id ?? 'empty'}:${tab}`
      : `${view}:${view === 'settings' ? nav.settingsCategory : nav.downloadCategory}`;
  const scroll = useRef<Record<string, number>>({ ...nav.scroll });
  useLayoutEffect(() => {
    const element = content.current;
    const positions = scroll.current;
    if (element) element.scrollTop = positions[location] ?? 0;
    return () => {
      if (element) positions[location] = element.scrollTop;
    };
  }, [location]);
  function change(patch: Partial<Navigation>, selectedId?: string) {
    guard(() => {
      if (content.current) scroll.current[location] = content.current.scrollTop;
      services.preferences.update({
        ...(selectedId ? { selectedId } : {}),
        navigation: {
          ...nav,
          ...patch,
          scroll: Object.fromEntries(
            Object.entries(scroll.current).slice(-300),
          ),
        },
      });
    });
  }
  const closeWindow = useCallback(() => {
    if (!isTauri()) return;
    allowClose.current = true;
    void getCurrentWindow()
      .close()
      .catch(() => {
        allowClose.current = false;
        setNotice('关闭窗口失败，请重试。');
      });
  }, []);
  const requestClose = useCallback(
    () =>
      guard(() => {
        void services.native.refresh(true).then(() => {
          if (services.native.snapshot().state?.task.status === 'running')
            setClosing(true);
          else closeWindow();
        });
      }),
    [guard, services.native, closeWindow],
  );
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (!allowClose.current) {
          event.preventDefault();
          requestClose();
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => setNotice('窗口关闭保护未连接，请先退出游戏再关闭。'));
    return () => {
      disposed = true;
      stop?.();
    };
  }, [requestClose]);
  useEffect(
    () => () => {
      if (background) URL.revokeObjectURL(background);
    },
    [background],
  );
  async function run(operation: () => Promise<unknown>) {
    setNotice('');
    try {
      await operation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    }
  }
  function resize(delta: number) {
    services.preferences.update({
      sidebarWidth: Math.min(
        420,
        Math.max(240, preferences.sidebarWidth + delta),
      ),
    });
  }
  function selectTab(next: Navigation['instanceTabs'][string]) {
    if (selected)
      change({ instanceTabs: { ...nav.instanceTabs, [selected.id]: next } });
  }
  const category =
    view === 'settings'
      ? settingItems.find((item) => item.id === nav.settingsCategory)?.name
      : downloadItems.find((item) => item.id === nav.downloadCategory)?.name;
  const matches =
    state?.instances.filter((item) =>
      `${item.name} ${item.version} ${item.fabricVersion ? 'Fabric' : '原版'}`
        .toLowerCase()
        .includes(nav.query.toLowerCase()),
    ) ?? [];
  return (
    <div
      className="app native-library rail-layout"
      data-theme={preferences.theme}
      style={
        { '--sidebar-width': `${preferences.sidebarWidth}px` } as CSSProperties
      }
    >
      <Titlebar realMode report={setNotice} onClose={requestClose} />
      <div className={`library-shell ${collapsed ? 'library-collapsed' : ''}`}>
        <nav className="library-navigation global-rail" aria-label="主功能">
          {mainItems.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-pressed={view === id}
              className={view === id ? 'active' : ''}
              onClick={() => change({ section: id })}
            >
              <Icon size={25} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <aside className="library-sidebar" aria-label="实例与分类栏">
          {view === 'library' ? (
            <>
              <div className="library-list-heading">
                <h2>
                  我的游戏 <span>{state?.instances.length ?? 0}</span>
                </h2>
                <div>
                  <button
                    aria-label="安装新实例"
                    onClick={() =>
                      change({
                        section: 'download',
                        downloadCategory: 'vanilla',
                      })
                    }
                  >
                    <Plus size={17} />
                  </button>
                  <button
                    aria-label="刷新真实实例"
                    disabled={!native.available}
                    onClick={() => void run(services.native.refresh)}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              <div className="library-instance-list">
                {matches.map((item) => (
                  <button
                    key={item.id}
                    className={`library-instance ${selected?.id === item.id ? 'selected' : ''}`}
                    aria-pressed={selected?.id === item.id}
                    onClick={() => change({}, item.id)}
                    onDoubleClick={() => {
                      if (
                        preferences.doubleClickLaunch &&
                        !running &&
                        native.available &&
                        state &&
                        (state.settings.launchMode === 'offline' ||
                          state.account)
                      )
                        void run(() => services.native.launch(item.id));
                    }}
                  >
                    <span
                      className={`instance-block ${item.fabricVersion ? 'fabric-block' : ''}`}
                    >
                      <Box size={27} />
                    </span>
                    <span className="library-instance-name">
                      <strong>{item.name}</strong>
                      <small>
                        {item.version} ·{' '}
                        {item.fabricVersion
                          ? `Fabric ${item.fabricVersion}`
                          : '原版'}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
                {!state?.instances.length && (
                  <div className="library-empty">
                    <Box size={30} />
                    <strong>添加你的第一个实例</strong>
                    <p>原版或 Fabric，独立保存你的世界。</p>
                    <button
                      onClick={() =>
                        change({
                          section: 'download',
                          downloadCategory: 'vanilla',
                        })
                      }
                    >
                      前往安装
                    </button>
                  </div>
                )}
                {!!state?.instances.length && !matches.length && (
                  <div className="library-empty">
                    <p>没有匹配的实例</p>
                    <button onClick={() => change({ query: '' })}>
                      清除搜索
                    </button>
                  </div>
                )}
              </div>
              <div className="library-sidebar-tools">
                <label className="library-search">
                  <Search size={17} />
                  <input
                    aria-label="搜索真实实例"
                    value={nav.query}
                    maxLength={256}
                    placeholder="搜索名称或游戏版本…"
                    onChange={(event) =>
                      services.preferences.update({
                        navigation: { ...nav, query: event.target.value },
                      })
                    }
                  />
                </label>
                <button
                  className="library-import-link"
                  onClick={() =>
                    change({ section: 'download', downloadCategory: 'modpack' })
                  }
                >
                  <FolderOpen size={22} />
                  <span>
                    <strong>整合包内容检查</strong>
                    <small>ZIP / MRPACK，安装能力逐步接入</small>
                  </span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="library-list-heading">
                <h2>{view === 'settings' ? '设置' : '下载内容'}</h2>
              </div>
              <div className="context-category-list">
                {(view === 'settings' ? settingItems : downloadItems).map(
                  ({ id, name, icon: Icon }) => (
                    <button
                      key={id}
                      className={
                        (view === 'settings'
                          ? nav.settingsCategory
                          : nav.downloadCategory) === id
                          ? 'selected'
                          : ''
                      }
                      aria-pressed={
                        (view === 'settings'
                          ? nav.settingsCategory
                          : nav.downloadCategory) === id
                      }
                      onClick={() =>
                        view === 'settings'
                          ? change({
                              settingsCategory:
                                id as Navigation['settingsCategory'],
                            })
                          : change({
                              downloadCategory:
                                id as Navigation['downloadCategory'],
                            })
                      }
                    >
                      <Icon size={19} />
                      {name}
                    </button>
                  ),
                )}
              </div>
              <p className="context-tip">
                {view === 'settings'
                  ? '这里调整全局默认设置；实例音画与世界配置在游戏库中管理。'
                  : '资源安装需要明确目标实例；数据包还需要选择目标世界。'}
              </p>
            </>
          )}
          <button
            className="account library-account"
            aria-label="管理游戏账户"
            onClick={() => setAccount(true)}
          >
            <SkinAvatar service={services.native} />
            <span>
              <strong>{identity || '选择游戏账户'}</strong>
              <small>
                {identity
                  ? state?.settings.launchMode === 'offline'
                    ? '离线账户'
                    : 'Microsoft 正版账户'
                  : '正版登录 / 离线登录'}
              </small>
            </span>
            <ChevronRight size={17} />
          </button>
        </aside>
        <div
          className="divider library-divider"
          role="separator"
          aria-label="调整实例栏宽度"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuenow={preferences.sidebarWidth}
          aria-valuemin={240}
          aria-valuemax={420}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              resize(event.key === 'ArrowRight' ? 10 : -10);
            }
          }}
          onPointerDown={(event) => {
            pointer.current = event.clientX;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (pointer.current !== null) {
              const delta = event.clientX - pointer.current;
              pointer.current = event.clientX;
              resize(delta);
            }
          }}
          onPointerUp={() => {
            pointer.current = null;
          }}
          onPointerCancel={() => {
            pointer.current = null;
          }}
        >
          <span>⋮</span>
        </div>
        <main className="library-main">
          <div className="workspace-breadcrumb">
            <button
              aria-label="展开或折叠实例栏"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              <Menu size={17} />
            </button>
            <span>
              Easy Craft / {mainItems.find((item) => item.id === view)?.name} /{' '}
              <strong>
                {view === 'library' ? (selected?.name ?? '尚无实例') : category}
              </strong>
            </span>
            {collapsed && (
              <button
                aria-label="管理游戏账户"
                onClick={() => setAccount(true)}
              >
                <SkinAvatar service={services.native} />
              </button>
            )}
          </div>
          <div className="library-content page-content" ref={content}>
            {!native.available && (
              <p className="notice" role="status">
                浏览器仅预览界面。真实实例、存档与账户来自桌面版，不会显示虚构的游戏数据。
              </p>
            )}
            {(notice || native.error) && (
              <p className="notice" role="alert">
                {notice || native.error}
              </p>
            )}
            {view === 'library' && (
              <>
                <section
                  className={`library-hero ${tab !== 'overview' ? 'compact-hero' : ''}`}
                  style={{
                    backgroundImage: `linear-gradient(0deg,rgba(11,37,28,.95),rgba(20,47,38,.05) 85%),url("${background || landscape}")`,
                  }}
                >
                  {tab === 'overview' && (
                    <div className="library-hero-wordmark">
                      EASY CRAFT<span>YOUR WORLD, YOUR WAY</span>
                    </div>
                  )}
                  <div className="library-hero-bottom">
                    <div>
                      <h1>{selected?.name ?? '你的世界，准备出发。'}</h1>
                      <div className="library-chips">
                        <span>
                          <Box size={13} />
                          {selected
                            ? `Minecraft ${selected.version}`
                            : '独立实例'}
                        </span>
                        {selected && (
                          <>
                            <span>
                              {selected.fabricVersion
                                ? `Fabric ${selected.fabricVersion}`
                                : '原版旅程'}
                            </span>
                            <span>
                              <Cpu size={13} />
                              Java {selected.javaMajor}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      className="library-launch"
                      disabled={!canLaunch}
                      onClick={() =>
                        selected &&
                        void run(() => services.native.launch(selected.id))
                      }
                    >
                      <Play fill="currentColor" size={21} />
                      {running ? '游戏 / 任务运行中' : '启动游戏'}
                    </button>
                  </div>
                </section>
                <div
                  className="library-tabs"
                  role="tablist"
                  aria-label="实例工作区"
                >
                  {(
                    [
                      { id: 'overview', name: '实例详情' },
                      { id: 'worlds', name: '存档' },
                      { id: 'options', name: '实例设置' },
                    ] as const
                  ).map(({ id, name }) => (
                    <button
                      key={id}
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => selectTab(id)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {tab === 'overview' ? (
                  <div className="library-details-grid">
                    <div>
                      <section className="card library-description">
                        <h2>
                          {selected ? '属于你的独立世界' : '从一个世界开始'}
                        </h2>
                        <p>
                          {selected
                            ? '实例的存档与配置独立保存。启动前可调整世界规则，音量和视距在实例设置中修改。'
                            : '安装你喜欢的版本，再选择账户开始冒险。这里仅展示真实安装的实例。'}
                        </p>
                        <div className="library-tags">
                          <span>本地保存</span>
                          <span>独立实例</span>
                          <span>配置可备份</span>
                        </div>
                      </section>
                      <section className="card">
                        <h2>快速操作</h2>
                        <div className="button-row">
                          <button
                            disabled={!selected}
                            onClick={() => selectTab('worlds')}
                          >
                            世界设置
                          </button>
                          <button
                            onClick={() =>
                              change({
                                section: 'settings',
                                settingsCategory: 'launch',
                              })
                            }
                          >
                            内存与 Java
                          </button>
                          <button onClick={() => setAccount(true)}>
                            账户与皮肤头像
                          </button>
                        </div>
                      </section>
                    </div>
                    <section className="card library-facts">
                      <h2>实例信息</h2>
                      <dl>
                        <dt>游戏版本</dt>
                        <dd>{selected?.version ?? '尚未安装'}</dd>
                        <dt>加载器</dt>
                        <dd>
                          {selected?.fabricVersion
                            ? `Fabric ${selected.fabricVersion}`
                            : '原版'}
                        </dd>
                        <dt>Java 版本</dt>
                        <dd>
                          {selected
                            ? `Java ${selected.javaMajor} (x64)`
                            : '等待选择实例'}
                        </dd>
                        <dt>启动身份</dt>
                        <dd>{identity || '尚未选择账户'}</dd>
                        <dt>堆内存</dt>
                        <dd>
                          {state?.settings.memoryMode === 'auto'
                            ? '自动分配 · 全局默认'
                            : `${state?.settings.memoryMb ?? 2048} MB · 全局默认`}
                        </dd>
                      </dl>
                    </section>
                  </div>
                ) : selected ? (
                  <WorldSettingsPanel
                    key={`${selected.id}:${tab}`}
                    service={services.native}
                    id={selected.id}
                    running={!!running}
                    section={tab === 'options' ? 'options' : 'world'}
                  />
                ) : (
                  <section className="card library-empty">
                    <Globe2 size={30} />
                    <h2>先选择一个已安装实例</h2>
                    <button
                      onClick={() =>
                        change({
                          section: 'download',
                          downloadCategory: 'vanilla',
                        })
                      }
                    >
                      安装实例
                    </button>
                  </section>
                )}
              </>
            )}
            {view === 'settings' && (
              <div className="workspace-page">
                <div className="library-page-heading">
                  <span>PREFERENCES</span>
                  <h1>{category}设置</h1>
                  <p>全局默认；运行环境更改在下次启动时生效。</p>
                </div>
                {nav.settingsCategory === 'launch' && (
                  <>
                    {(!native.available || state) && (
                      <>
                        <JavaPanel service={services.native} />
                        <MemoryPanel service={services.native} />
                      </>
                    )}
                    <section className="card">
                      <h2>启动行为</h2>
                      <label className="toggle-row">
                        <span>允许双击实例启动（默认关闭）</span>
                        <input
                          aria-label="双击实例启动"
                          type="checkbox"
                          checked={preferences.doubleClickLaunch}
                          onChange={(event) =>
                            services.preferences.update({
                              doubleClickLaunch: event.target.checked,
                            })
                          }
                        />
                      </label>
                    </section>
                  </>
                )}
                {nav.settingsCategory === 'appearance' && (
                  <section className="card">
                    <h2>外观</h2>
                    <div className="theme-grid">
                      {services.themes.listThemes().map((theme) => (
                        <button
                          key={theme.id}
                          className={`theme-card ${preferences.theme === theme.id ? 'chosen' : ''}`}
                          aria-pressed={preferences.theme === theme.id}
                          onClick={() =>
                            services.themes.activateTheme(theme.id)
                          }
                        >
                          <span className={`theme-preview ${theme.id}`} />
                          <strong>{theme.name}</strong>
                          <small>{theme.description}</small>
                        </button>
                      ))}
                    </div>
                    <label className="file-setting">
                      实例页背景（本地预览）
                      <input
                        aria-label="选择背景图片"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          if (
                            file.size > 10 * 1024 * 1024 ||
                            !['image/png', 'image/jpeg', 'image/webp'].includes(
                              file.type,
                            )
                          ) {
                            setNotice(
                              '请选择小于 10 MB 的 PNG、JPEG 或 WebP 图片',
                            );
                            return;
                          }
                          setBackground(URL.createObjectURL(file));
                        }}
                      />
                    </label>
                    {background && (
                      <button onClick={() => setBackground('')}>
                        恢复原创背景
                      </button>
                    )}
                  </section>
                )}
                {nav.settingsCategory === 'downloads' && (
                  <section className="card">
                    <h2>下载与缓存</h2>
                    <p>
                      当前采用已验证的有限并发、重试、哈希校验、缓存复用与取消。并发和重试次数暂不开放修改。
                    </p>
                    {state && (
                      <p className="data-root">数据目录：{state.dataRoot}</p>
                    )}
                    <button
                      onClick={() =>
                        change({
                          section: 'download',
                          downloadCategory: 'vanilla',
                        })
                      }
                    >
                      前往原版游戏下载
                    </button>
                  </section>
                )}
                {nav.settingsCategory === 'other' && (
                  <section className="card">
                    <h2>关于与诊断</h2>
                    <p>Easy Craft · 独立实例、真实下载与启动。</p>
                    {state && (
                      <p className="data-root">数据目录：{state.dataRoot}</p>
                    )}
                    <button onClick={() => setTasks(true)}>
                      查看任务与脱敏日志
                    </button>
                    <details>
                      <summary>演示与开发</summary>
                      <p>演示样例不是真实游戏实例。</p>
                      <button
                        onClick={() =>
                          guard(() => {
                            window.location.search = '?demo=1';
                          })
                        }
                      >
                        进入演示工作区
                      </button>
                    </details>
                  </section>
                )}
              </div>
            )}
            {view === 'download' && (
              <div className="workspace-page">
                {nav.downloadCategory === 'vanilla' ? (
                  <NativeWorkspace
                    compact
                    service={services.native}
                    onAccount={() => setAccount(true)}
                  />
                ) : (
                  <>
                    <div className="library-page-heading">
                      <span>CONTENT</span>
                      <h1>{category}</h1>
                      <p>安装前选择目标实例，并检查版本兼容和变更。</p>
                    </div>
                    {nav.downloadCategory === 'modpack' ? (
                      <PackInspector service={services.native} />
                    ) : (
                      <section className="card">
                        <h2>在线{category}安装正在接入</h2>
                        <p>
                          尚未提供此类别的真实检索与安装，不会显示模拟搜索结果。原版/Fabric
                          安装和整合包检查可继续使用。
                        </p>
                        <button
                          onClick={() =>
                            change({ downloadCategory: 'vanilla' })
                          }
                        >
                          原版游戏
                        </button>
                      </section>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <footer className="workspace-taskbar">
            <span>
              {running
                ? task?.pid
                  ? 'Minecraft 运行中'
                  : task?.message
                : task?.status === 'failed'
                  ? `任务失败：${task.message}`
                  : task?.status === 'cancelled'
                    ? '任务已取消'
                    : task?.status === 'succeeded'
                      ? '任务已完成'
                      : '没有正在进行的任务'}
            </span>
            <button onClick={() => setTasks(true)}>查看任务</button>
          </footer>
        </main>
      </div>
      {account && (
        <Modal title="账户" onClose={() => setAccount(false)}>
          <AccountPanel
            service={services.native}
            onDone={() => setAccount(false)}
          />
        </Modal>
      )}
      {tasks && (
        <Modal title="任务与日志" onClose={() => setTasks(false)}>
          <p role="status">{task?.message || '没有正在进行的任务。'}</p>
          {task && task.total > 0 && !task.pid && (
            <progress
              aria-label="游戏任务进度"
              value={task.completed}
              max={task.total}
            />
          )}
          <pre className="diagnostics game-log">
            {task?.logs.join('\n') || '暂无日志'}
          </pre>
          {running && (
            <button onClick={() => void run(services.native.cancel)}>
              {task?.pid ? '结束游戏进程' : '取消任务'}
            </button>
          )}
        </Modal>
      )}
      {closing && (
        <Modal title="游戏仍在运行" onClose={() => setClosing(false)}>
          <p>
            关闭启动器会结束由它启动的
            Minecraft。请先保存并退出世界，避免丢失进度。
          </p>
          <div className="button-row">
            <button onClick={() => setClosing(false)}>取消关闭</button>
            <button onClick={closeWindow}>确认结束游戏并关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
