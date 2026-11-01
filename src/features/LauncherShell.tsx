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
import { getCurrentWebview } from '@tauri-apps/api/webview';
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
  Cpu,
  Palette,
  MoreHorizontal,
  Layers,
  Package,
  Image,
  FileCode,
  Puzzle,
  ShieldCheck,
  AlertTriangle,
  Check,
} from 'lucide-react';
import { uiScales, type Services } from '../core/contracts';
import { warnings } from '../app/bootstrap';
import { defaultNavigation, type Navigation } from '../core/navigation';
import { Titlebar } from '../components/Titlebar';
import { Modal } from '../components/Modal';
import { SkinAvatar } from '../components/SkinAvatar';
import { backgroundImage } from './background-image';
import { libraryFolders } from '../core/library-folders';
import {
  instanceSettings,
  instanceLoader,
  instanceIsolated,
  instanceGameDirectory,
} from '../core/instance-settings';
import { AccountPanel } from './AccountPanel';
import { MemoryPanel } from './MemoryPanel';
import { CachePanel } from './CachePanel';
import { JavaPanel } from './JavaPanel';
import { NativeWorkspace } from './NativeWorkspace';
import { WorldSettingsPanel } from './WorldSettingsPanel';
import { ContentPanel } from './ContentPanel';
import { ResourceBrowser } from './ResourceBrowser';
import { PackInspector } from './PackInspector';
import { LocalVersionImport } from './LocalVersionImport';
import { AddInstanceMenu } from './AddInstanceMenu';
import { IsolationPanel } from './IsolationPanel';
import { InstanceSettings } from './InstanceSettings';
import type { PackPreview, LocalVersionScan } from '../core/native-contracts';
import {
  ExtensionsPanel,
  ExtensionsSidebar,
  PluginHost,
  InstancePluginEntries,
  InstancePluginWorkspace,
  type ExtensionGroupId,
} from './ExtensionsPanel';
import { InstanceOverview } from './InstanceOverview';
import { LaunchChecks, useModCheck } from './LaunchChecks';
import layout from '../plugins/official/layout.json';
import { UnsavedChanges, useNavigationGuard } from './UnsavedChanges';
import landscape from '../assets/landscape-dusk.png';
import '../themes/library.css';
import '../themes/rail.css';
import '../themes/instance.css';
import { accentStyle } from '../themes/accent';
import { installProgress } from '../core/install-progress';
import { TaskDiagnostics } from './TaskDiagnostics';

const mainItems = [
  { id: 'library', name: '游戏库', icon: Box },
  { id: 'download', name: '下载', icon: Download },
  { id: 'extensions', name: '扩展', icon: Puzzle },
  { id: 'settings', name: '设置', icon: Settings },
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
  const available = native.available;
  const selected =
    state?.instances.find((item) => item.id === preferences.selectedId) ??
    state?.instances[0];
  const tab = (selected && nav.instanceTabs[selected.id]) ?? 'overview';
  const effectiveSettings = state
    ? instanceSettings(state.settings, selected)
    : null;
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
    (state?.settings.launchMode === 'offline'
      ? /^[A-Za-z0-9_]{3,16}$/.test(state.settings.offlineName)
      : !!state?.account);
  const [account, setAccount] = useState(false);
  const [extensionId, setExtensionId] = useState('');
  const [instanceExtension, setInstanceExtension] = useState<{
    id: string;
    plugin: string;
  } | null>(null);
  const [extensionGroup, setExtensionGroup] = useState<ExtensionGroupId | null>(
    'tools',
  );
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [localScan, setLocalScan] = useState<LocalVersionScan | null>(null);
  const [pickedPack, setPickedPack] = useState<PackPreview | null>(null);
  const [packPicking, setPackPicking] = useState(false);
  async function importLocalPack() {
    setPackPicking(true);
    try {
      await run(async () => {
        const value = await services.native.pickPack();
        if (value) setPickedPack(value);
      });
    } finally {
      setPackPicking(false);
    }
  }
  const [checksOpen, setChecksOpen] = useState(false);
  const [javaPending, setJavaPending] = useState(false);
  const [javaFailure, setJavaFailure] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const launchPending = useRef(false);
  const checks = useModCheck(
    services.native,
    selected?.id,
    JSON.stringify([
      selected?.version,
      selected?.fabricVersion,
      selected?.local,
      effectiveSettings?.javaPath,
      selected?.javaMajor,
      selected ? instanceIsolated(selected) : true,
      native.modRevision,
    ]),
    !!running,
    preferences.autoModCheck !== false,
  );
  const [notice, setNotice] = useState(warnings.at(-1) ?? '');
  useEffect(() => {
    const warning = () => setNotice(warnings.at(-1) ?? '');
    window.addEventListener('easycraft-warning', warning);
    return () => window.removeEventListener('easycraft-warning', warning);
  }, []);
  const [collapsed, setCollapsed] = useState(false);
  const [compact, setCompact] = useState(window.innerWidth < 800);
  const [contextOpen, setContextOpen] = useState(false);
  const expanded = compact ? contextOpen : !collapsed;
  const contextToggle = useRef<HTMLButtonElement>(null);
  const contextPanel = useRef<HTMLElement>(null);
  const initialScale = useRef(preferences.uiScale ?? 100);
  const [uiScale, setUiScale] = useState<number | null>(isTauri() ? null : 100);
  const [scaleBusy, setScaleBusy] = useState(isTauri());
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void getCurrentWebview()
      .setZoom(initialScale.current / 100)
      .then(() => {
        if (!disposed) setUiScale(initialScale.current);
      })
      .catch(() => {
        if (!disposed) setNotice('恢复界面缩放失败，请在个性化中重新选择。');
      })
      .finally(() => {
        if (!disposed) setScaleBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    let previous = window.innerWidth < 800;
    const resize = () => {
      const next = window.innerWidth < 800;
      setCompact(next);
      if (next !== previous) setContextOpen(false);
      previous = next;
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!compact || !contextOpen) return;
    const toggle = contextToggle.current;
    contextPanel.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
    const close = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open], .instance-context-menu')
      ) {
        event.preventDefault();
        setContextOpen(false);
      }
    };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
      requestAnimationFrame(() => {
        if (toggle?.isConnected) toggle.focus();
      });
    };
  }, [compact, contextOpen]);
  async function changeScale(next: NonNullable<typeof preferences.uiScale>) {
    if (!isTauri()) return;
    setScaleBusy(true);
    try {
      await getCurrentWebview().setZoom(next / 100);
      setUiScale(next);
      services.preferences.update({ uiScale: next });
    } catch {
      setNotice('界面缩放未能应用，请重试；没有保存新的缩放比例。');
    } finally {
      setScaleBusy(false);
    }
  }
  const [background, setBackground] = useState('');
  const [droppedPack, setDroppedPack] = useState<File | null>(null);
  const consumeDroppedPack = useCallback(() => setDroppedPack(null), []);
  const [backgroundBusy, setBackgroundBusy] = useState(available);
  const [tasks, setTasks] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const resourceKind =
    (selected && nav.resourceKinds?.[selected.id]) ?? 'resourcepacks';
  const contentKind =
    tab === 'mods'
      ? 'mods'
      : tab === 'screenshots'
        ? 'screenshots'
        : resourceKind;
  const contentQueryKey = `${selected?.id ?? ''}:${contentKind}`;
  const [rename, setRename] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [removal, setRemoval] = useState<{
    id: string;
    name: string;
    managed: boolean;
    path: string;
  } | null>(null);
  const [archiveInstance, setArchiveInstance] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  function requestRemoval(id: string) {
    const item = state?.instances.find((v) => v.id === id);
    if (!item || running || !available) return;
    const normalize = (p: string) =>
      p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const managed =
      !!item.local?.versionDirectory.match(/^versions\/[^/]+$/) ||
      !!item.versionFolder ||
      !item.local ||
      (normalize(item.local.root) === normalize(state!.dataRoot) &&
        item.local.versionDirectory === `instances/${id}/game`);
    const path = item.versionFolder
      ? instanceGameDirectory(item, state!.dataRoot, true)
      : item.local
        ? `${item.local.root}/${item.local.versionDirectory}`
        : `${item.storageRoot ?? state!.dataRoot}/instances/${id}`;
    setRemoval({ id, name: item.name, managed, path });
    setArchiveInstance(managed);
    setRemoveError('');
    setMenu(null);
  }
  const [menu, setMenu] = useState<{
    id: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (menu) {
      const trigger = menuTrigger.current;
      menuRef.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus();
      return () => trigger?.focus();
    }
  }, [menu]);
  const allowClose = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const guard = useNavigationGuard();
  const location =
    view === 'library'
      ? `library:${selected?.id ?? 'empty'}:${tab}${tab === 'resources' ? `:${resourceKind}` : ''}`
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
  function change(
    patch: Partial<Navigation>,
    selectedId?: string,
    onChanged?: () => void,
  ) {
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
      setContextOpen(false);
      onChanged?.();
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
  }, [setNotice]);
  const requestClose = useCallback(
    () =>
      guard(() => {
        void services.native.refresh(true).then(() => {
          if (services.native.snapshot().state?.task.status === 'running')
            setClosing(true);
          else closeWindow();
        });
      }),
    [guard, services.native, closeWindow, setClosing],
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
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    void services.native
      .background()
      .then((value) => {
        if (!disposed) setBackground(value ?? '');
      })
      .catch((error) => {
        if (!disposed)
          setNotice(error instanceof Error ? error.message : '背景读取失败');
      })
      .finally(() => {
        if (!disposed) setBackgroundBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [available, services.native]);
  async function changeBackground(file?: File) {
    setBackgroundBusy(true);
    try {
      await run(async () => {
        const png = file ? await backgroundImage(file) : null;
        const value = available
          ? await services.native.background(
              png ? Array.from(new Uint8Array(await png.arrayBuffer())) : [],
            )
          : png
            ? await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('背景读取失败'));
                reader.readAsDataURL(png);
              })
            : null;
        setBackground(value ?? '');
        setNotice(
          available
            ? '背景已保存，下次打开仍然生效。'
            : '当前为浏览器预览，背景未保存到桌面应用。',
        );
      });
    } finally {
      setBackgroundBusy(false);
    }
  }
  async function run(operation: () => Promise<unknown>) {
    setNotice('');
    try {
      await operation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
    }
  }
  async function requestLaunch() {
    if (
      !selected ||
      running ||
      state?.loginPending ||
      !available ||
      launchPending.current
    )
      return;
    if (!canLaunch) {
      setAccount(true);
      return;
    }
    launchPending.current = true;
    const id = selected.id;
    try {
      setJavaPending(true);
      setJavaFailure(null);
      try {
        try {
          await services.native.instanceJava(id);
        } catch (error) {
          if (selected.launch?.javaPath) throw error;
          await services.native.prepareJava(id);
        }
      } catch (error) {
        setJavaFailure({
          id,
          message: error instanceof Error ? error.message : 'Java 检查未完成',
        });
        setChecksOpen(true);
        return;
      } finally {
        setJavaPending(false);
      }
      if (checks.busy) {
        setChecksOpen(true);
        return;
      }
      setChecksOpen(true);
      const report = await checks.verify();
      if (!launchPending.current) return;
      const current = services.native.snapshot().state;
      const currentId =
        current?.instances.find(
          (item) => item.id === services.preferences.snapshot().selectedId,
        )?.id ?? current?.instances[0]?.id;
      if (currentId !== id) return;
      if (report === null || report?.issues.length) setChecksOpen(true);
      else {
        setChecksOpen(false);
        await run(() => services.native.launch(id));
      }
    } finally {
      launchPending.current = false;
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
    setInstanceExtension(null);
    if (selected)
      change({ instanceTabs: { ...nav.instanceTabs, [selected.id]: next } });
  }
  const category =
    view === 'settings'
      ? settingItems.find((item) => item.id === nav.settingsCategory)?.name
      : view === 'extensions'
        ? '插件与布局'
        : downloadItems.find((item) => item.id === nav.downloadCategory)?.name;
  const matches =
    state?.instances.filter((item) =>
      `${item.name} ${item.version} ${instanceLoader(item)}`
        .toLowerCase()
        .includes(nav.query.toLowerCase()),
    ) ?? [];
  const shade = (preferences.backgroundShade ?? 35) / 100;
  const backgroundStyle = {
    backgroundImage: `linear-gradient(90deg,rgba(20,26,30,${Math.min(0.98, shade + 0.4)}),rgba(20,26,30,${shade})),url("${background || landscape}")`,
  };
  return (
    <div
      className="app native-library rail-layout"
      data-theme={preferences.theme}
      data-layout={preferences.layout ?? 'default'}
      data-reduce-motion={preferences.reduceMotion ? 'true' : undefined}
      data-custom-accent={preferences.accentColor ? 'true' : undefined}
      style={
        {
          '--sidebar-width': `${preferences.sidebarWidth}px`,
          '--hero-height': `${layout.presets[preferences.layout ?? 'default'].heroHeight}px`,
          '--content-gap': `${layout.presets[preferences.layout ?? 'default'].contentGap}px`,
          ...accentStyle(preferences.accentColor, preferences.theme),
        } as CSSProperties
      }
    >
      <Titlebar realMode report={setNotice} onClose={requestClose} />
      <PluginHost
        services={services}
        active={view === 'extensions'}
        onInstalled={(id, category) => {
          setExtensionId(id);
          setExtensionGroup(category);
        }}
      />
      <div
        className={`library-shell ${!expanded ? 'library-collapsed' : ''} ${compact ? 'compact-context' : ''}`}
      >
        <nav className="library-navigation global-rail" aria-label="主功能">
          {[...mainItems]
            .sort(
              (a, b) =>
                layout.navigation.indexOf(a.id) -
                layout.navigation.indexOf(b.id),
            )
            .map(({ id, name, icon: Icon }) => (
              <button
                key={id}
                aria-pressed={view === id}
                className={`${view === id ? 'active' : ''} ${id === 'settings' ? 'rail-settings' : ''}`}
                onClick={() =>
                  change({ section: id }, undefined, () =>
                    setContextOpen(compact),
                  )
                }
              >
                <Icon size={22} />
                <span>{name}</span>
              </button>
            ))}
        </nav>
        <aside
          className="library-sidebar"
          aria-label="实例与分类栏"
          ref={contextPanel}
        >
          {view === 'library' ? (
            <>
              <div className="library-list-heading">
                <h2>
                  我的游戏 <span>{state?.instances.length ?? 0}</span>
                </h2>
                <div>
                  <AddInstanceMenu
                    disabled={
                      !available ||
                      running ||
                      !!state?.loginPending ||
                      packPicking
                    }
                    onPack={() => void importLocalPack()}
                    onLocal={() => setLocalImportOpen(true)}
                  />
                  <button
                    aria-label="刷新真实实例"
                    disabled={!native.available}
                    onClick={() => void run(services.native.refresh)}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              <label className="library-search sidebar-search">
                <Search size={16} />
                <input
                  aria-label="搜索真实实例"
                  value={nav.query}
                  maxLength={256}
                  placeholder="搜索实例"
                  onChange={(event) =>
                    services.preferences.update({
                      navigation: { ...nav, query: event.target.value },
                    })
                  }
                />
              </label>
              <div className="library-instance-list">
                {task?.pendingInstance && (
                  <button
                    className="library-instance pending-install"
                    style={
                      {
                        '--install-fill': `${installProgress(task).percent}%`,
                      } as CSSProperties
                    }
                    onClick={() => {
                      setInstallOpen(true);
                      change({ section: 'library' });
                    }}
                  >
                    {' '}
                    <Download size={24} />
                    <span>
                      <strong>{task.pendingInstance}</strong>
                      <small>
                        {task.status === 'running'
                          ? '正在安装'
                          : task.status === 'failed'
                            ? '安装失败 · 查看原因'
                            : '安装已取消'}{' '}
                        ·{' '}
                        {task.total
                          ? `${installProgress(task).percent}%（整体）`
                          : '处理中'}
                      </small>
                      <progress
                        aria-label="待安装实例整体进度"
                        value={installProgress(task).percent}
                        max={100}
                      />
                    </span>
                  </button>
                )}
                {libraryFolders(matches, state?.dataRoot ?? '').map((group) => (
                  <details
                    className="library-folder"
                    key={`${group.path}:${nav.query}`}
                    open
                  >
                    <summary title={group.path}>
                      <FolderOpen size={17} />
                      <span>
                        <strong>{group.label}</strong>
                        <small>{group.path}</small>
                      </span>
                      <span className="library-folder-count">
                        {group.instances.length}
                      </span>
                    </summary>
                    {group.instances.map((item) => (
                      <div className="library-instance-row" key={item.id}>
                        <button
                          className={`library-instance ${selected?.id === item.id ? 'selected' : ''}`}
                          aria-pressed={selected?.id === item.id}
                          onClick={() => {
                            setInstallOpen(false);
                            change({}, item.id);
                          }}
                          onKeyDown={(event) => {
                            if (running || !available) return;
                            if (event.key === 'F2') {
                              event.preventDefault();
                              setRename({ id: item.id, name: item.name });
                            }
                            if (event.key === 'Delete') {
                              event.preventDefault();
                              requestRemoval(item.id);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            menuTrigger.current = event.currentTarget;
                            setMenu({
                              id: item.id,
                              name: item.name,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                          onDoubleClick={() => {
                            if (
                              preferences.doubleClickLaunch &&
                              !running &&
                              native.available &&
                              state &&
                              (state.settings.launchMode === 'offline' ||
                                state.account)
                            )
                              void requestLaunch();
                          }}
                        >
                          <span
                            className={`instance-block ${item.fabricVersion ? 'fabric-block' : ''}`}
                          >
                            <Box size={27} />
                          </span>
                          <span className="library-instance-name">
                            <strong title={item.name}>{item.name}</strong>
                            <small>
                              {item.version} · {instanceLoader(item)}
                            </small>
                          </span>
                          {selected?.id === item.id &&
                          !!checks.report?.issues.length ? (
                            <AlertTriangle
                              className="instance-warning"
                              size={16}
                              aria-label={`${checks.report.issues.length} 项启动建议`}
                            />
                          ) : null}
                        </button>
                        <button
                          className="instance-row-menu"
                          aria-label={`管理实例 ${item.name}`}
                          title="管理实例"
                          aria-haspopup="menu"
                          onClick={(event) => {
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            menuTrigger.current = event.currentTarget;
                            setMenu({
                              id: item.id,
                              name: item.name,
                              x: rect.right,
                              y: rect.bottom,
                            });
                          }}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                    ))}
                  </details>
                ))}
                {!state?.instances.length && (
                  <div className="library-empty">
                    <Box size={30} />
                    <strong>还没有游戏实例</strong>
                    <p>安装游戏或导入整合包，开始你的冒险。</p>
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
                <button
                  className="library-import-link"
                  disabled={
                    !available ||
                    running ||
                    !!state?.loginPending ||
                    packPicking
                  }
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!available || running || state?.loginPending) {
                      setNotice(
                        '请使用桌面版，并先结束当前任务或登录，再拖入整合包。',
                      );
                      return;
                    }
                    if (event.dataTransfer.files.length !== 1) {
                      setNotice('请每次拖入一个 ZIP 或 MRPACK 文件');
                      return;
                    }
                    const file = event.dataTransfer.files[0];
                    if (!/\.(zip|mrpack)$/i.test(file.name)) {
                      setNotice('请拖入 ZIP 或 MRPACK 文件');
                      return;
                    }
                    change(
                      { section: 'download', downloadCategory: 'modpack' },
                      undefined,
                      () => setDroppedPack(file),
                    );
                  }}
                  onClick={() => void importLocalPack()}
                >
                  <FolderOpen size={22} />
                  <span>
                    <strong>导入整合包</strong>
                    <small>拖入 ZIP / MRPACK</small>
                  </span>
                </button>
              </div>
            </>
          ) : view === 'extensions' ? (
            <ExtensionsSidebar
              expanded={extensionGroup}
              onExpand={setExtensionGroup}
              selected={extensionId}
              onSelect={setExtensionId}
            />
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
              <strong title={identity || '选择游戏账户'}>
                {identity || '选择游戏账户'}
              </strong>
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
        {compact && contextOpen && (
          <button
            className="context-scrim"
            aria-label="关闭实例与分类栏"
            onClick={() => setContextOpen(false)}
          />
        )}
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
        <main className="library-main" inert={compact && contextOpen}>
          <div className="workspace-breadcrumb">
            <button
              aria-label="展开或折叠实例栏"
              aria-expanded={expanded}
              ref={contextToggle}
              onClick={() =>
                compact
                  ? setContextOpen(!contextOpen)
                  : setCollapsed(!collapsed)
              }
            >
              <Menu size={17} />
            </button>
            <span>
              Easy Craft / {mainItems.find((item) => item.id === view)?.name} /{' '}
              <strong>
                {view === 'library' ? (selected?.name ?? '尚无实例') : category}
              </strong>
            </span>
            {!expanded && (
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
            {view === 'library' && installOpen && task?.pendingInstance && (
              <div className="workspace-page install-workspace">
                <div className="library-page-heading">
                  <h1>{task.pendingInstance}</h1>
                  <button onClick={() => setInstallOpen(false)}>
                    返回实例
                  </button>
                </div>
                <p>整体安装进度 · {installProgress(task).percent}%（按阶段）</p>
                <progress
                  style={{ width: '100%' }}
                  value={installProgress(task).percent}
                  max={100}
                />
                <ol className="task-steps">
                  {installProgress(task).rows.map((row) => (
                    <li key={row.id}>
                      <strong>{row.name}</strong>
                      <span>
                        {row.status} · {row.percent}%
                      </span>
                      <progress value={row.percent} max={100} />
                    </li>
                  ))}
                </ol>
                <p role="status">{task.message}</p>
                <div className="button-row">
                  {running && (
                    <button onClick={() => void run(services.native.cancel)}>
                      取消安装
                    </button>
                  )}
                  <button onClick={() => setTasks(true)}>详细日志</button>
                </div>
              </div>
            )}
            {view === 'library' &&
              !(installOpen && task?.pendingInstance) &&
              !selected && (
                <section className="library-welcome" style={backgroundStyle}>
                  <div className="welcome-emblem">
                    <Box size={38} />
                  </div>
                  <span className="welcome-kicker">EASY CRAFT</span>
                  <h1>下一个世界，从这里开始。</h1>
                  <p>
                    安装 Minecraft，或带上你喜欢的整合包。
                    <br />
                    每个实例独立保存，让冒险各有天地。
                  </p>
                  <div className="welcome-actions">
                    <button
                      className="primary"
                      onClick={() =>
                        change({
                          section: 'download',
                          downloadCategory: 'vanilla',
                        })
                      }
                    >
                      <Plus size={18} /> 安装游戏
                    </button>
                    <button
                      disabled={
                        !available ||
                        running ||
                        !!state?.loginPending ||
                        packPicking
                      }
                      onClick={() => void importLocalPack()}
                    >
                      <FolderOpen size={18} /> 导入整合包
                    </button>
                  </div>
                  <small>支持原版与 Fabric · ZIP / MRPACK 导入</small>
                </section>
              )}
            {view === 'library' &&
              !(installOpen && task?.pendingInstance) &&
              selected && (
                <>
                  <section
                    className={`library-hero ${tab !== 'overview' ? 'compact-hero' : 'overview-hero'}`}
                    style={{
                      ...backgroundStyle,
                    }}
                  >
                    {tab !== 'overview' && (
                      <button
                        className="hero-menu"
                        aria-label="当前实例更多操作"
                        onClick={(event) => {
                          menuTrigger.current = event.currentTarget;
                          const bounds =
                            event.currentTarget.getBoundingClientRect();
                          setMenu({
                            id: selected.id,
                            name: selected.name,
                            x: bounds.right - 230,
                            y: bounds.bottom,
                          });
                        }}
                      >
                        <MoreHorizontal size={19} />
                      </button>
                    )}
                    <div className="library-hero-bottom">
                      <div>
                        <h1 title={selected.name}>{selected.name}</h1>
                        <div className="library-chips">
                          <span>
                            <Box size={13} />
                            {selected
                              ? `Minecraft ${selected.version}`
                              : '独立实例'}
                          </span>
                          {selected && (
                            <>
                              <span>{instanceLoader(selected)}</span>
                              <span>
                                <Cpu size={13} />
                                需要 Java {selected.javaMajor}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="hero-launch-group">
                        <button
                          className="library-launch"
                          disabled={
                            !available ||
                            running ||
                            !!state?.loginPending ||
                            javaPending
                          }
                          onClick={() => void requestLaunch()}
                        >
                          <Play fill="currentColor" size={21} />
                          {running
                            ? '游戏 / 任务运行中'
                            : javaPending
                              ? '正在检查 Java…'
                              : !canLaunch
                                ? '选择账号后启动'
                                : '启动游戏'}
                        </button>
                        <span className="launch-identity">
                          {identity ? (
                            `${identity} · ${running ? '运行中' : state?.settings.launchMode === 'offline' ? '离线账户' : 'Microsoft'}`
                          ) : (
                            <button onClick={() => setAccount(true)}>
                              选择账号后启动
                            </button>
                          )}
                        </span>
                      </div>
                    </div>
                  </section>
                  <button
                    className={`preflight-summary ${checks.report?.issues.length ? 'has-warning' : ''}`}
                    onClick={() => setChecksOpen(true)}
                  >
                    {checks.report?.issues.length ? (
                      <AlertTriangle size={15} />
                    ) : (
                      <ShieldCheck size={15} />
                    )}
                    <span>
                      {checks.busy
                        ? checks.report
                          ? '正在核对文件变化，上次报告待更新…'
                          : '正在检查本地模组…'
                        : checks.stale
                          ? '上次报告待更新 · 可查看详情或详细检查'
                          : checks.error
                            ? '启动检查未完成，仍可启动'
                            : checks.report?.issues.length
                              ? `发现 ${checks.report.issues.length} 项依赖问题，仍可启动`
                              : checks.report?.details?.complete
                                ? '支持范围内未发现声明问题 · 查看检查详情'
                                : checks.report
                                  ? '检查未完成 · 查看范围与建议'
                                  : '尚未检查 · 查看范围与建议'}
                    </span>
                    {checks.report?.details && (
                      <small
                        className="check-time"
                        title={new Date(
                          checks.report.details.checkedAt,
                        ).toLocaleString()}
                      >
                        {checks.stale ? '上次' : '核对'}{' '}
                        {new Date(
                          checks.report.details.checkedAt,
                        ).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </small>
                    )}
                    <ChevronRight size={14} />
                  </button>
                  <div
                    className="library-tabs"
                    role="tablist"
                    aria-label="实例工作区"
                    onKeyDown={(event) => {
                      if (
                        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const tabs = Array.from(
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          '[role="tab"]',
                        ),
                      );
                      const current = tabs.indexOf(
                        document.activeElement as HTMLButtonElement,
                      );
                      const index =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? tabs.length - 1
                            : (current +
                                (event.key === 'ArrowRight' ? 1 : -1) +
                                tabs.length) %
                              tabs.length;
                      tabs[index]?.click();
                      tabs[index]?.focus();
                    }}
                  >
                    {(
                      [
                        { id: 'overview', name: '概览' },
                        { id: 'mods', name: '模组' },
                        { id: 'resources', name: '资源与光影' },
                        { id: 'worlds', name: '存档' },
                        { id: 'screenshots', name: '截图' },
                        { id: 'options', name: '实例设置' },
                      ] as const
                    ).map(({ id, name }) => (
                      <button
                        key={id}
                        role="tab"
                        tabIndex={tab === id ? 0 : -1}
                        aria-selected={
                          tab === id && instanceExtension?.id !== selected.id
                        }
                        onClick={() => selectTab(id)}
                      >
                        {name}
                      </button>
                    ))}
                    <InstancePluginEntries
                      id={selected.id}
                      position="instance-tab"
                      selectedPlugin={
                        instanceExtension?.id === selected.id
                          ? instanceExtension.plugin
                          : undefined
                      }
                      onOpen={(plugin) =>
                        setInstanceExtension({ id: selected.id, plugin })
                      }
                    />
                  </div>
                  {tab === 'overview' && (
                    <InstancePluginEntries
                      id={selected.id}
                      position="instance-overview"
                      onOpen={(plugin) =>
                        setInstanceExtension({ id: selected.id, plugin })
                      }
                    />
                  )}
                  {instanceExtension?.id === selected.id ? (
                    <div className="workspace-page">
                      <InstancePluginWorkspace
                        plugin={instanceExtension.plugin}
                        id={selected.id}
                        services={services}
                      />
                    </div>
                  ) : tab === 'overview' ? (
                    <InstanceOverview
                      key={`${selected.id}:${instanceIsolated(selected)}`}
                      service={services.native}
                      instance={selected}
                      settings={effectiveSettings!}
                      identity={identity ?? ''}
                      running={!!running}
                      onWorlds={() => selectTab('worlds')}
                      onMods={() => selectTab('mods')}
                      onSettings={() => selectTab('options')}
                      onChecks={() => setChecksOpen(true)}
                      onRename={() =>
                        setRename({ id: selected.id, name: selected.name })
                      }
                      onRemove={() => requestRemoval(selected.id)}
                      report={setNotice}
                    />
                  ) : selected &&
                    (tab === 'mods' ||
                      tab === 'resources' ||
                      tab === 'screenshots') ? (
                    <>
                      <ContentPanel
                        key={`${selected.id}:${tab}:${resourceKind}:${instanceIsolated(selected)}`}
                        service={services.native}
                        id={selected.id}
                        kind={contentKind}
                        categorySwitch={
                          tab === 'resources' ? (
                            <div
                              className="content-subtabs"
                              aria-label="资源类型"
                            >
                              {(['resourcepacks', 'shaderpacks'] as const).map(
                                (kind) => (
                                  <button
                                    key={kind}
                                    aria-pressed={resourceKind === kind}
                                    onClick={() =>
                                      change({
                                        resourceKinds: {
                                          ...nav.resourceKinds,
                                          [selected.id]: kind,
                                        },
                                      })
                                    }
                                  >
                                    {kind === 'resourcepacks'
                                      ? '资源包'
                                      : '光影包'}
                                  </button>
                                ),
                              )}
                            </div>
                          ) : undefined
                        }
                        query={nav.contentQueries?.[contentQueryKey] ?? ''}
                        onQuery={(query) =>
                          change({
                            contentQueries: Object.fromEntries(
                              Object.entries({
                                ...nav.contentQueries,
                                [contentQueryKey]: query,
                              }).slice(-300),
                            ),
                          })
                        }
                        running={!!running}
                        onDownload={() =>
                          change({
                            section: 'download',
                            downloadCategory:
                              tab === 'mods'
                                ? 'mod'
                                : resourceKind === 'shaderpacks'
                                  ? 'shader'
                                  : 'resourcepack',
                          })
                        }
                      />
                    </>
                  ) : selected && tab === 'options' ? (
                    <InstanceSettings
                      key={`${selected.id}:settings`}
                      service={services.native}
                      id={selected.id}
                      running={!!running}
                    />
                  ) : selected ? (
                    <>
                      <WorldSettingsPanel
                        key={`${selected.id}:${tab}:${instanceIsolated(selected)}`}
                        service={services.native}
                        id={selected.id}
                        running={!!running}
                        section="world"
                        onDatapacks={(worldId) =>
                          change({
                            section: 'download',
                            downloadCategory: 'datapack',
                            datapackWorlds: {
                              ...nav.datapackWorlds,
                              [selected.id]: worldId,
                            },
                          })
                        }
                      />
                    </>
                  ) : (
                    <section className="card library-empty">
                      <Box size={30} />
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
                  <h1>
                    {nav.settingsCategory === 'downloads'
                      ? '下载设置'
                      : `${category}设置`}
                  </h1>
                  <p>
                    {nav.settingsCategory === 'appearance'
                      ? '选择你的配色与背景，调整后立即生效。'
                      : nav.settingsCategory === 'launch'
                        ? '全局默认，运行环境更改在下次启动时生效。'
                        : nav.settingsCategory === 'downloads'
                          ? '管理下载文件与本地缓存。'
                          : '应用信息、日志与诊断工具。'}
                  </p>
                </div>
                {nav.settingsCategory === 'launch' && (
                  <>
                    {(!native.available || state) && (
                      <>
                        <JavaPanel service={services.native} />
                        <MemoryPanel service={services.native} />
                        <IsolationPanel service={services.native} />
                      </>
                    )}
                    <section className="card">
                      <h2>启动行为</h2>
                      <label className="toggle-row">
                        <span>选中实例后自动检查 Mod 依赖</span>
                        <input
                          aria-label="自动检查 Mod 依赖"
                          type="checkbox"
                          checked={preferences.autoModCheck !== false}
                          onChange={(event) =>
                            services.preferences.update({
                              autoModCheck: event.target.checked,
                            })
                          }
                        />
                      </label>
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
                    <label className="native-label accent-setting">
                      自定义强调色
                      <input
                        aria-label="自定义强调色"
                        type="color"
                        value={preferences.accentColor ?? '#3d913d'}
                        onChange={(event) =>
                          services.preferences.update({
                            accentColor: event.target.value,
                          })
                        }
                      />
                    </label>
                    <button
                      disabled={!preferences.accentColor}
                      onClick={() =>
                        services.preferences.update({ accentColor: undefined })
                      }
                    >
                      恢复默认强调色
                    </button>
                    <label className="file-setting">
                      实例页背景{available ? '（保存到本机）' : '（本地预览）'}
                      <input
                        aria-label="选择背景图片"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={backgroundBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void changeBackground(file);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    {background && (
                      <button
                        disabled={backgroundBusy}
                        onClick={() => void changeBackground()}
                      >
                        恢复原创背景
                      </button>
                    )}
                    <p className="hint">
                      PNG / JPEG / WebP，最大 10 MiB。
                      {backgroundBusy ? '正在保存…' : ''}
                    </p>
                    <div
                      className="appearance-background-preview"
                      aria-label="背景遮罩预览"
                      style={backgroundStyle}
                    >
                      <strong>你的世界，由你设定</strong>
                      <span>与实例概览使用相同背景和遮罩</span>
                    </div>
                    <label className="native-label">
                      背景遮罩强度：{preferences.backgroundShade ?? 35}%
                      <input
                        aria-label="背景遮罩强度"
                        type="range"
                        min="20"
                        max="80"
                        step="1"
                        value={preferences.backgroundShade ?? 35}
                        onChange={(event) =>
                          services.preferences.update({
                            backgroundShade: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="toggle-row">
                      <span>减少动态效果</span>
                      <input
                        aria-label="减少动态效果"
                        type="checkbox"
                        checked={preferences.reduceMotion ?? false}
                        onChange={(event) =>
                          services.preferences.update({
                            reduceMotion: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label className="native-label">
                      界面缩放
                      <select
                        aria-label="界面缩放"
                        value={uiScale ?? preferences.uiScale ?? 100}
                        disabled={!isTauri() || scaleBusy}
                        onChange={(event) => {
                          const scale = uiScales.find(
                            (scale) => scale === Number(event.target.value),
                          );
                          if (scale) void changeScale(scale);
                        }}
                      >
                        {uiScales.map((scale) => (
                          <option key={scale} value={scale}>
                            {scale}%{scale === 100 ? '（默认）' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={!isTauri() || scaleBusy || uiScale === 100}
                      onClick={() => void changeScale(100)}
                    >
                      恢复 100% 缩放
                    </button>
                    <p className="hint">
                      {isTauri()
                        ? scaleBusy
                          ? '正在应用界面缩放…'
                          : uiScale === null
                            ? '未能确认当前缩放，请重新选择或恢复 100%。'
                            : `当前界面缩放 ${uiScale}%。偏好保存失败时只在当前窗口生效。`
                        : '界面缩放需要桌面版；浏览器预览不会模拟原生缩放。'}
                      放大后空间不足时，可从内容区顶部展开实例与分类栏。
                    </p>
                  </section>
                )}
                {nav.settingsCategory === 'downloads' && (
                  <>
                    <section className="card">
                      <h2>下载与缓存</h2>
                      <p>
                        下载支持自动重试、文件校验和缓存复用，可在任务中查看进度或取消。
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
                    <CachePanel service={services.native} />
                  </>
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
              <div className="workspace-page download-page">
                {nav.downloadCategory === 'vanilla' ? (
                  <NativeWorkspace
                    compact
                    service={services.native}
                    onAccount={() => setAccount(true)}
                  />
                ) : (
                  <>
                    <div className="library-page-heading">
                      <h1>{category}</h1>
                      <p>
                        {nav.downloadCategory === 'modpack'
                          ? '选择整合包版本，检查归档后创建独立实例。'
                          : '安装前选择目标实例，并检查版本兼容和变更。'}
                      </p>
                    </div>
                    <ResourceBrowser
                      key={nav.downloadCategory}
                      selectedId={selected?.id}
                      worldSelection={nav.datapackWorlds}
                      incomingPack={droppedPack}
                      onPackConsumed={consumeDroppedPack}
                      onWorldSelection={(id, world) =>
                        change({
                          datapackWorlds: Object.fromEntries(
                            Object.entries({
                              ...nav.datapackWorlds,
                              [id]: world,
                            }).slice(-300),
                          ),
                        })
                      }
                      service={services.native}
                      kind={nav.downloadCategory}
                      query={
                        nav.contentQueries?.[
                          `download:${nav.downloadCategory}:query`
                        ] ?? ''
                      }
                      gameVersion={
                        nav.contentQueries?.[
                          `download:${nav.downloadCategory}:game`
                        ] ?? 'all'
                      }
                      onFilter={(query, game) =>
                        change({
                          contentQueries: Object.fromEntries(
                            Object.entries({
                              ...nav.contentQueries,
                              [`download:${nav.downloadCategory}:query`]: query,
                              [`download:${nav.downloadCategory}:game`]: game,
                            }).slice(-300),
                          ),
                        })
                      }
                    />
                  </>
                )}
              </div>
            )}
            {view === 'extensions' && (
              <ExtensionsPanel
                services={services}
                selected={extensionId}
                onSelect={setExtensionId}
              />
            )}
          </div>
          <footer className="workspace-taskbar">
            {running ? (
              <RefreshCw size={14} />
            ) : task?.status === 'failed' ? (
              <AlertTriangle size={14} />
            ) : (
              <Check size={14} />
            )}
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
                      ? task.message || '任务已完成'
                      : '没有正在进行的任务'}
            </span>
            {running && !task?.pid && (
              <div className="taskbar-progress" aria-label="当前任务进度">
                {task && task.total > 0 ? (
                  <>
                    <progress
                      aria-label="任务进度"
                      value={task.completed}
                      max={task.total}
                    />
                    <small>
                      {Math.round(
                        Math.min(1, task.completed / task.total) * 100,
                      )}
                      % ·{' '}
                      {['pack-download', 'pack-archive'].includes(task.phase)
                        ? `${(task.completed / 1048576).toFixed(1)}/${(task.total / 1048576).toFixed(1)} MiB`
                        : `${task.completed}/${task.total}`}
                    </small>
                  </>
                ) : (
                  <>
                    <progress aria-label="正在确定任务总量" />
                    <small>正在处理…</small>
                  </>
                )}
              </div>
            )}
            {localScan && (
              <button onClick={() => setLocalImportOpen(true)}>
                查看扫描结果
              </button>
            )}
            <button onClick={() => setTasks(true)}>任务与日志</button>
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
      {pickedPack && (
        <Modal title="导入本地整合包" onClose={() => setPickedPack(null)}>
          <PackInspector
            service={services.native}
            initialPreview={pickedPack}
            onStarted={() => {
              setPickedPack(null);
              setTasks(true);
            }}
          />
        </Modal>
      )}
      {localImportOpen && (
        <Modal
          title="扫描/导入本地版本"
          onClose={() => setLocalImportOpen(false)}
        >
          <LocalVersionImport
            service={services.native}
            initialScan={localScan}
            onScan={setLocalScan}
          />
        </Modal>
      )}
      {checksOpen && selected && (
        <Modal
          title={`启动检查 · ${selected.name}`}
          onClose={() => setChecksOpen(false)}
        >
          {javaFailure?.id === selected.id && (
            <section className="notice launch-java-failure" role="alert">
              <p>Java 检查未通过：{javaFailure.message}</p>
              <p>
                请在实例设置的运行环境中选择兼容的 64 位 Java，然后重新启动。
              </p>
              <button
                onClick={() => {
                  setChecksOpen(false);
                  selectTab('options');
                }}
              >
                打开实例设置
              </button>
            </section>
          )}
          <LaunchChecks
            report={checks.report}
            error={checks.error}
            busy={checks.busy}
            stale={checks.stale}
            canLaunch={canLaunch && !javaPending}
            onRefresh={() => void checks.refresh()}
            onLaunch={() => {
              launchPending.current = false;
              setChecksOpen(false);
              void run(() => services.native.launch(selected.id));
            }}
            onFind={() => {
              setChecksOpen(false);
              change({ section: 'download', downloadCategory: 'mod' });
            }}
            onLogs={() => {
              setChecksOpen(false);
              setTasks(true);
            }}
          />
        </Modal>
      )}
      {tasks && (
        <Modal title="任务与日志" onClose={() => setTasks(false)}>
          <p role="status">{task?.message || '没有正在进行的任务。'}</p>
          {state &&
            (task?.status === 'failed' || task?.status === 'cancelled') && (
              <TaskDiagnostics state={state} />
            )}
          <ol className="task-steps">
            {task?.steps?.map((step, index) => (
              <li key={index}>
                <strong>第 {index + 1} 步</strong>
                <span>{step.message}</span>
                {step.outcome === 'fallback' ? (
                  <span>来源不可用，已切换镜像</span>
                ) : step.done ? (
                  <span>完成 · 100%</span>
                ) : step.total > 0 ? (
                  <>
                    <progress value={step.completed} max={step.total} />
                    <span>
                      {Math.min(
                        100,
                        Math.floor((step.completed / step.total) * 100),
                      )}
                      % ·{' '}
                      {['pack-download', 'pack-archive'].includes(step.phase)
                        ? `${(step.completed / 1048576).toFixed(1)}/${(step.total / 1048576).toFixed(1)} MiB`
                        : `${step.completed}/${step.total}`}
                    </span>
                  </>
                ) : (
                  <span>
                    {task.status === 'running' ? '正在确定总量…' : task.status}
                  </span>
                )}
              </li>
            ))}
          </ol>
          {localScan && (
            <button
              onClick={() => {
                setTasks(false);
                setLocalImportOpen(true);
              }}
            >
              查看扫描结果并选择导入
            </button>
          )}
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
      {menu && (
        <div
          className="instance-menu-backdrop"
          role="presentation"
          onMouseDown={() => setMenu(null)}
        >
          <div
            ref={menuRef}
            className="instance-context-menu"
            role="menu"
            aria-label="实例操作"
            tabIndex={-1}
            style={{
              left: Math.max(0, Math.min(menu.x, window.innerWidth - 236)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - 300)),
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setMenu(null);
              } else if (
                ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
              ) {
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button:not(:disabled)',
                  ),
                );
                const index = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          items.length) %
                        items.length
                ]?.focus();
              }
            }}
          >
            <small>{menu.name}</small>
            <button
              role="menuitem"
              onClick={() => {
                change(
                  {
                    section: 'library',
                    instanceTabs: {
                      ...nav.instanceTabs,
                      [menu.id]: 'overview',
                    },
                  },
                  menu.id,
                );
                setMenu(null);
              }}
            >
              查看详情
            </button>
            <button
              role="menuitem"
              disabled={!!running || !native.available}
              onClick={() => {
                setRename({ id: menu.id, name: menu.name });
                setMenu(null);
              }}
            >
              重命名
            </button>
            <button
              role="menuitem"
              disabled={!!running || !native.available}
              onClick={() => {
                void run(() => services.native.openContent(menu.id));
                setMenu(null);
              }}
            >
              打开目录
            </button>
            <button role="menuitem" onClick={() => setMenu(null)}>
              关闭菜单
            </button>
            <button
              role="menuitem"
              disabled={!!running || !native.available}
              onClick={() => requestRemoval(menu.id)}
            >
              移除实例
            </button>
          </div>
        </div>
      )}
      {rename && (
        <Modal title="重命名实例" onClose={() => setRename(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await services.native.renameInstance(rename.id, rename.name);
                setRename(null);
              });
            }}
          >
            <label className="native-label">
              实例名称
              <input
                aria-label="真实实例名称"
                maxLength={120}
                required
                value={rename.name}
                onChange={(event) =>
                  setRename({ ...rename, name: event.target.value })
                }
              />
            </label>
            <p>只修改显示名称，实例目录和存档不会移动。</p>
            <button
              className="primary"
              type="submit"
              disabled={
                !rename.name.trim() ||
                Array.from(rename.name.trim()).length > 60 ||
                !!running
              }
            >
              保存实例名称
            </button>
          </form>
        </Modal>
      )}
      {removal && (
        <Modal title="移除实例" onClose={() => setRemoval(null)}>
          <p>将「{removal.name}」移出游戏库？</p>
          {removal.managed && (
            <p className="hint" style={{ overflowWrap: 'anywhere' }}>
              版本目录：{removal.path}
            </p>
          )}
          {removal.managed ? (
            <label className="toggle-row">
              <span>同时将此版本文件夹移入系统回收站</span>
              <input
                type="checkbox"
                checked={archiveInstance}
                disabled={removeBusy}
                onChange={(event) => setArchiveInstance(event.target.checked)}
              />
            </label>
          ) : (
            <p>这是引用的本地版本，只移除记录，原文件保留。</p>
          )}
          <p className="hint">
            {archiveInstance && removal.managed
              ? '版本文件夹将进入 Windows 回收站；共享目录保留，回收失败时不永久删除。'
              : '游戏文件、存档与模组保留在原位置。'}
          </p>
          {removeError && (
            <p className="notice" role="alert">
              {removeError}
            </p>
          )}
          <div className="content-toolbar">
            <button disabled={removeBusy} onClick={() => setRemoval(null)}>
              取消
            </button>
            <button
              className="primary"
              disabled={removeBusy || !!running}
              onClick={() => {
                setRemoveBusy(true);
                setRemoveError('');
                void services.native
                  .removeInstance(
                    removal.id,
                    removal.managed && archiveInstance,
                  )
                  .then((path) => {
                    if (
                      services.preferences.snapshot().selectedId === removal.id
                    )
                      services.preferences.update({
                        selectedId:
                          services.native.snapshot().state?.instances[0]?.id,
                      });
                    setRemoval(null);
                    setNotice(
                      path
                        ? `已移入系统回收站，原位置：${path}`
                        : '实例已移出游戏库，原文件保留。',
                    );
                  })
                  .catch((error) =>
                    setRemoveError(
                      error instanceof Error ? error.message : '移除失败',
                    ),
                  )
                  .finally(() => setRemoveBusy(false));
              }}
            >
              {removeBusy ? '正在移除…' : '确认移除'}
            </button>
          </div>
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
