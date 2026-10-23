import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import {
  Box,
  Download,
  Settings,
  Search,
  Plus,
  RefreshCw,
  Play,
  FolderOpen,
  SlidersHorizontal,
  UserRound,
  ChevronRight,
  Menu,
  Globe2,
  Sparkles,
  Cpu,
  ArrowUpRight,
} from 'lucide-react';
import type { Services } from '../core/contracts';
import { Titlebar } from '../components/Titlebar';
import { Modal } from '../components/Modal';
import { SkinAvatar } from '../components/SkinAvatar';
import { AccountPanel } from './AccountPanel';
import { MemoryPanel } from './MemoryPanel';
import { NativeWorkspace } from './NativeWorkspace';
import { WorldSettingsPanel } from './WorldSettingsPanel';
import landscape from '../assets/landscape.svg';
import '../themes/library.css';

export function LauncherShell({ services }: { services: Services }) {
  const native = useSyncExternalStore(
    services.native.subscribe,
    services.native.snapshot,
  );
  const preferences = useSyncExternalStore(
    services.preferences.subscribe,
    services.preferences.snapshot,
  );
  const [view, setView] = useState<'library' | 'download' | 'settings'>(
    'library',
  );
  const [tab, setTab] = useState<'overview' | 'worlds'>('overview');
  const [account, setAccount] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [background, setBackground] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const state = native.state;
  const selected =
    state?.instances.find((item) => item.id === preferences.selectedId) ??
    state?.instances[0];
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
  useEffect(
    () => () => {
      if (background) URL.revokeObjectURL(background);
    },
    [background],
  );
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [view, tab]);
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
  return (
    <div
      className="app native-library"
      data-theme={preferences.theme}
      style={
        { '--sidebar-width': `${preferences.sidebarWidth}px` } as CSSProperties
      }
    >
      <Titlebar realMode report={setNotice} />
      <div className={`library-shell ${collapsed ? 'library-collapsed' : ''}`}>
        <aside className="library-sidebar" aria-label="游戏实例栏">
          <nav className="library-navigation" aria-label="主功能">
            {(
              [
                { id: 'library', name: '版本', icon: Box },
                { id: 'download', name: '下载中心', icon: Download },
                { id: 'settings', name: '设置', icon: Settings },
              ] as const
            ).map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                aria-pressed={view === id}
                className={view === id ? 'active' : ''}
                onClick={() => setView(id)}
              >
                <Icon size={22} />
                <span>{name}</span>
              </button>
            ))}
            <button onClick={() => setAccount(true)}>
              <UserRound size={22} />
              <span>账户</span>
            </button>
          </nav>
          <div className="library-list-heading">
            <h2>
              实例列表 <span>{state?.instances.length ?? 0}</span>
            </h2>
            <div>
              <button
                aria-label="安装新实例"
                title="安装新实例"
                onClick={() => setView('download')}
              >
                <Plus size={17} />
              </button>
              <button
                aria-label="刷新真实实例"
                title="刷新实例"
                disabled={!native.available}
                onClick={() => void run(services.native.refresh)}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
          <div className="library-instance-list">
            {state?.instances
              .filter((item) =>
                `${item.name} ${item.version}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((item) => (
                <button
                  key={item.id}
                  className={`library-instance ${selected?.id === item.id ? 'selected' : ''}`}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => {
                    services.preferences.update({ selectedId: item.id });
                    setView('library');
                    setTab('overview');
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
                <button onClick={() => setView('download')}>前往安装</button>
              </div>
            )}
            {!!state?.instances.length &&
              !state.instances.some((item) =>
                `${item.name} ${item.version}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ) && <p className="library-empty">没有匹配的实例</p>}
          </div>
          <div className="library-sidebar-tools">
            <label className="library-search">
              <Search size={17} />
              <input
                aria-label="搜索真实实例"
                value={query}
                placeholder="搜索名称或游戏版本…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="library-import-link"
              onClick={() => setView('download')}
            >
              <FolderOpen size={24} />
              <span>
                <strong>整合包内容预览</strong>
                <small>检查 ZIP / MRPACK，当前不自动安装</small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          </div>
          <button
            className="account library-account"
            aria-label="管理游戏账户"
            onClick={() => setAccount(true)}
          >
            <SkinAvatar service={services.native} />
            <span>
              <strong>{identity || '选择游戏账户'}</strong>
              <small>
                <i />
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
            if (pointer.current === null) return;
            const delta = event.clientX - pointer.current;
            pointer.current = event.clientX;
            resize(delta);
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
          <div className="library-mobile-bar">
            <button
              aria-label="展开或折叠实例栏"
              onClick={() => setCollapsed(!collapsed)}
            >
              <Menu size={19} />
            </button>
            <span>我的游戏库</span>
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
                  className="library-hero"
                  style={{
                    backgroundImage: `linear-gradient(0deg,rgba(11,37,28,.95),rgba(20,47,38,.05) 85%),url("${background || landscape}")`,
                  }}
                >
                  <div className="library-hero-wordmark">
                    EASY CRAFT<span>YOUR WORLD, YOUR WAY</span>
                  </div>
                  <div className="library-hero-bottom">
                    <div>
                      <p className="hero-kicker">
                        <Sparkles size={13} />
                        下一个冒险，由你设定
                      </p>
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
                  <button
                    role="tab"
                    aria-selected={tab === 'overview'}
                    onClick={() => setTab('overview')}
                  >
                    <SlidersHorizontal size={17} />
                    实例详情
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === 'worlds'}
                    onClick={() => setTab('worlds')}
                  >
                    <Globe2 size={17} />
                    存档与设置
                  </button>
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
                            ? '游戏资源、存档和配置各自保存。进入游戏前，你可以调整这个实例的音量、画面选项，或修改已有世界的难度和游戏规则。'
                            : '安装你喜欢的游戏版本，再选择账户开始冒险。这里展示真实安装的实例，演示资料保留在独立入口。'}
                        </p>
                        <div className="library-tags">
                          <span>本地保存</span>
                          <span>独立实例</span>
                          <span>可调整世界</span>
                        </div>
                        <button
                          className="text-button"
                          disabled={!selected}
                          onClick={() => setTab('worlds')}
                        >
                          管理存档与游戏设置
                          <ChevronRight size={15} />
                        </button>
                      </section>
                      <section className="card library-shortcuts">
                        <h2>准备你的下一次出发</h2>
                        <button
                          disabled={!selected}
                          onClick={() => setTab('worlds')}
                        >
                          <Globe2 />
                          <span>
                            <strong>世界设置</strong>
                            <small>难度、时间、天气与游戏规则</small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                        <button onClick={() => setView('settings')}>
                          <Cpu />
                          <span>
                            <strong>内存与性能</strong>
                            <small>自动分配，或使用自己的设置</small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                        <button onClick={() => setAccount(true)}>
                          <UserRound />
                          <span>
                            <strong>账户与皮肤头像</strong>
                            <small>切换身份，显示玩家的皮肤头像</small>
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      </section>
                    </div>
                    <div>
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
                              ? '自动分配'
                              : `${state?.settings.memoryMb ?? 2048} MB`}
                          </dd>
                        </dl>
                      </section>
                      <section className="card library-note">
                        <span>小提示</span>
                        <h3>让设置先准备好</h3>
                        <p>
                          保存世界配置前会备份原文件。关闭游戏后编辑，下次进入世界即可应用。
                        </p>
                      </section>
                    </div>
                  </div>
                ) : selected ? (
                  <WorldSettingsPanel
                    key={selected.id}
                    service={services.native}
                    id={selected.id}
                    running={!!running}
                  />
                ) : (
                  <section className="card library-empty">
                    <Globe2 size={30} />
                    <h2>先选择一个已安装实例</h2>
                    <p>真实存档将从该实例的 saves 目录读取。</p>
                    <button onClick={() => setView('download')}>
                      安装实例
                    </button>
                  </section>
                )}
              </>
            )}
            {view === 'download' && (
              <NativeWorkspace
                service={services.native}
                onAccount={() => setAccount(true)}
              />
            )}
            {view === 'settings' && (
              <>
                <div className="library-page-heading">
                  <span>MAKE IT YOURS</span>
                  <h1>偏好设置</h1>
                  <p>让启动器适合你的使用习惯。</p>
                </div>
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
                <MemoryPanel service={services.native} />
                <section className="card">
                  <h2>演示与开发</h2>
                  <p>保留早期模拟工作区，里面的样例资料不是真实游戏实例。</p>
                  <button
                    onClick={() => {
                      window.location.search = '?demo=1';
                    }}
                  >
                    进入演示工作区
                  </button>
                </section>
              </>
            )}
            {view !== 'download' && task && task.status !== 'idle' && (
              <section className="card library-task" aria-label="游戏任务">
                <div className="section-heading">
                  <h2>
                    {running
                      ? task.pid
                        ? 'Minecraft 进程运行中'
                        : '游戏任务进行中'
                      : task.status === 'failed'
                        ? '游戏任务失败'
                        : task.status === 'cancelled'
                          ? '游戏任务已取消'
                          : '游戏任务已完成'}
                  </h2>
                  {running && (
                    <button onClick={() => void run(services.native.cancel)}>
                      {task.pid ? '结束游戏进程' : '取消任务'}
                    </button>
                  )}
                </div>
                <p role="status">{task.message}</p>
                {task.total > 0 && (
                  <progress
                    aria-label="游戏任务进度"
                    value={task.completed}
                    max={task.total}
                  />
                )}
                <details open={task.status === 'failed'}>
                  <summary>查看游戏日志</summary>
                  <pre className="diagnostics game-log">
                    {task.logs.join('\n') || '暂无游戏日志'}
                  </pre>
                </details>
              </section>
            )}
          </div>
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
    </div>
  );
}
