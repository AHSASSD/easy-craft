import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Download, Play, ShieldCheck } from 'lucide-react';
import type { NativeService, NativeSettings } from '../core/native-contracts';
import { PackInspector } from './PackInspector';
import { instanceLoader, instanceIsolated } from '../core/instance-settings';
import { DownSelect } from '../components/DownSelect';
import minecraftIcon from '../assets/minecraft-official.png';
import fabricIcon from '../assets/fabric-official.png';
import forgeIcon from '../assets/forge-official.png';

export function NativeWorkspace({
  service,
  onAccount,
  compact = false,
}: {
  service: NativeService;
  onAccount(): void;
  compact?: boolean;
}) {
  const snapshot = useSyncExternalStore(service.subscribe, service.snapshot);
  const [draft, setDraft] = useState<NativeSettings | null>(null);
  const [versions, setVersions] = useState<
    { id: string; releaseTime: string; type?: string }[]
  >([]);
  const [versionQuery, setVersionQuery] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [version, setVersion] = useState('1.21.1');
  const [loader, setLoader] = useState('vanilla');
  const [fabricVersion, setFabricVersion] = useState('');
  const [forgeVersion, setForgeVersion] = useState('');
  const [loaderCatalog, setLoaderCatalog] = useState<{
    loader: string;
    game: string;
    games: string[];
    versions: string[];
    recommended: string | null;
    error: string;
  } | null>(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [name, setName] = useState('我的原版世界');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const state = snapshot.state;
  const catalogRequest = useRef(0);
  function chooseGame(next: string) {
    setVersion(next);
    setFabricVersion('');
    setForgeVersion('');
    setError('');
    setFeedback('');
  }
  useEffect(() => {
    if (loader === 'vanilla' || !snapshot.available) return;
    let disposed = false;
    const load = async () => {
      if (loader === 'forge') {
        const rows = await service.forgeVersions(version);
        return {
          games: rows.gameVersions,
          versions: rows.versions,
          recommended: rows.recommended,
        };
      }
      const games = await service.fabricGames();
      const entries = games.includes(version)
        ? await service.fabricCatalog(version)
        : { versions: [], recommended: null };
      return {
        games,
        ...entries,
      };
    };
    void load()
      .then((rows) => {
        if (disposed) return;
        setLoaderCatalog({ loader, game: version, ...rows, error: '' });
        if (!rows.games.includes(version)) {
          const next =
            versions.find(
              (entry) =>
                (entry.type ?? 'release') === 'release' &&
                rows.games.includes(entry.id),
            )?.id ??
            [...rows.games].sort((a, b) =>
              b.localeCompare(a, 'en', { numeric: true }),
            )[0];
          if (next) chooseGame(next);
          return;
        }
        if (loader === 'fabric')
          setFabricVersion((previous) =>
            rows.versions.includes(previous)
              ? previous
              : (rows.recommended ?? rows.versions[0] ?? ''),
          );
        else
          setForgeVersion((previous) =>
            rows.versions.includes(previous)
              ? previous
              : rows.recommended && rows.versions.includes(rows.recommended)
                ? rows.recommended
                : (rows.versions[0] ?? ''),
          );
      })
      .catch((error) => {
        if (!disposed)
          setLoaderCatalog({
            loader,
            game: version,
            games: [],
            versions: [],
            recommended: null,
            error:
              error instanceof Error ? error.message : '加载器版本读取失败',
          });
      });
    return () => {
      disposed = true;
    };
  }, [service, snapshot.available, loader, version, catalogRetry, versions]);
  const loaderReady =
    loaderCatalog?.loader === loader && loaderCatalog.game === version;
  const loaderRows = loaderReady ? loaderCatalog.versions : [];
  const fabricVersions = loader === 'fabric' ? loaderRows : [];
  const forgeVersions = loader === 'forge' ? loaderRows : [];
  const gameChoices =
    loader === 'vanilla'
      ? versions.map((entry) => entry.id)
      : loaderCatalog?.loader === loader
        ? loaderCatalog.games
        : [];
  const loaderName = loader === 'fabric' ? 'Fabric' : 'Forge';
  const loaderIcon = loader === 'fabric' ? fabricIcon : forgeIcon;
  useEffect(() => {
    if (!snapshot.available) return;
    let disposed = false;
    const ticket = ++catalogRequest.current;
    void service
      .versionCatalog()
      .then((values) => {
        if (!disposed && ticket === catalogRequest.current) setVersions(values);
      })
      .catch((error: unknown) => {
        if (!disposed && ticket === catalogRequest.current)
          setCatalogError(
            error instanceof Error ? error.message : '官方版本列表读取失败',
          );
      });
    return () => {
      disposed = true;
    };
  }, [service, snapshot.available]);
  const settings = draft ??
    state?.settings ?? {
      clientId: '',
      javaPath: '',
      memoryMb: 2048,
      memoryMode: 'auto',
      optimizeMemory: false,
      launchMode: 'microsoft',
      offlineName: '',
    };
  const active = state?.task.status === 'running';
  const taskRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active) taskRef.current?.scrollIntoView({ block: 'start' });
  }, [active]);
  const locked = busy || !!active || !!state?.loginPending;
  const selectedVersion = versions.find((entry) => entry.id === version);
  async function run(operation: () => Promise<unknown>, success = '') {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await operation();
      if (success) setFeedback(success);
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const current = service.snapshot().state?.settings;
      if (!current) throw new Error('运行配置尚未连接');
      await service.saveSettings({ ...current, javaPath: settings.javaPath });
      setDraft(null);
    }, '原生配置已保存。');
  }
  return (
    <div className="native-workspace">
      <h1>
        {loader === 'vanilla'
          ? compact
            ? '原版游戏'
            : '原版下载与启动'
          : loader === 'forge'
            ? 'Forge 安装器'
            : 'Fabric 游戏'}
      </h1>
      <p>
        {loader === 'forge'
          ? '从 Forge 官方目录选择并下载安装器；当前不自动创建 Forge 实例。'
          : '从官方来源安装独立实例，支持原版与 Fabric。安装成功后在游戏库中启动。'}
      </p>
      {!snapshot.available && (
        <div className="notice" role="status">
          浏览器仅提供演示。请运行桌面版使用正版登录、资源下载和游戏启动；此页面不会在浏览器中模拟这些能力。
        </div>
      )}
      {(error || snapshot.error) && (
        <div className="notice" role="alert">
          {error || snapshot.error}
        </div>
      )}
      {feedback && (
        <div className="notice" role="status">
          {feedback}
        </div>
      )}
      {busy && <p role="status">正在处理，请稍候…</p>}
      {snapshot.available && !state && (
        <button disabled={busy} onClick={() => void run(service.refresh)}>
          重新连接原生服务
        </button>
      )}
      <fieldset
        disabled={!snapshot.available || !state}
        className="native-fieldset"
      >
        {!compact && (
          <section className="card">
            <h2>
              <ShieldCheck size={17} />
              运行配置
            </h2>
            <form onSubmit={save}>
              <label>
                Java 可执行文件
                <input
                  aria-label="Java 可执行文件"
                  value={settings.javaPath}
                  placeholder="E:\…\bin\java.exe"
                  onChange={(event) =>
                    setDraft({ ...settings, javaPath: event.target.value })
                  }
                />
              </label>
              <div className="button-row">
                <button
                  type="button"
                  disabled={locked || !settings.javaPath}
                  onClick={() =>
                    void run(async () => {
                      const java = await service.probeJava(settings.javaPath);
                      setFeedback(
                        `Java ${java.major} · ${java.is64Bit ? '64 位' : '32 位'} · 检测成功`,
                      );
                    })
                  }
                >
                  检测 Java
                </button>
              </div>
              <p className="hint">内存分配可在「设置 → 游戏内存」调整。</p>
              <button className="primary" type="submit" disabled={locked}>
                保存原生配置
              </button>
            </form>
            {state && <p className="data-root">数据目录：{state.dataRoot}</p>}
          </section>
        )}
        {!compact && (
          <section className="card">
            <h2>游戏账户</h2>
            <p>点击左下角头像，选择正版登录或离线登录。</p>
            <button onClick={onAccount}>切换游戏账户</button>
          </section>
        )}
        <section className="vanilla-install-panel">
          <div className="vanilla-install-controls card">
            <div className="section-heading">
              <h2>
                <Download size={17} />{' '}
                {loader === 'forge'
                  ? '下载 Forge 安装器'
                  : loader === 'fabric'
                    ? '安装 Fabric 实例'
                    : '安装原版实例'}
              </h2>
              <button
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const ticket = ++catalogRequest.current;
                    const values = await service.versionCatalog();
                    if (ticket === catalogRequest.current) {
                      setVersions(values);
                      setCatalogError('');
                    }
                  }, '已读取官方版本清单。')
                }
              >
                刷新官方版本
              </button>
            </div>
            <div className="install-fields">
              <label className="native-label">
                游戏版本
                <DownSelect
                  label="原版版本"
                  value={version}
                  options={gameChoices.map((game) => ({
                    value: game,
                    label: game,
                  }))}
                  onChange={chooseGame}
                  allowCustom={loader === 'vanilla'}
                  disabled={locked}
                />
              </label>
              <label className="native-label">
                加载器
                <select
                  aria-label="真实实例加载器"
                  value={loader}
                  onChange={(event) => {
                    setLoader(event.target.value);
                    setError('');
                    setFeedback('');
                    setVersionQuery('');
                  }}
                >
                  <option value="vanilla">原版</option>
                  <option value="fabric">Fabric</option>
                  <option value="forge">Forge 安装器下载</option>
                </select>
              </label>
              {loader === 'fabric' && (
                <>
                  <label className="native-label">
                    Fabric Loader 版本
                    <input
                      aria-label="Fabric Loader 版本"
                      list="fabric-versions"
                      value={fabricVersion}
                      onChange={(event) => setFabricVersion(event.target.value)}
                    />
                  </label>
                  <datalist id="fabric-versions">
                    {fabricVersions.map((entry) => (
                      <option key={entry} value={entry} />
                    ))}
                  </datalist>
                  <button
                    disabled={locked}
                    onClick={() => {
                      setCatalogRetry((value) => value + 1);
                      setError('');
                    }}
                  >
                    刷新 Fabric 版本
                  </button>
                  <p className="hint">
                    安装预览：Minecraft {version} + Fabric {fabricVersion}
                    ，创建新的独立实例；下载来源为 Fabric 官方元数据与
                    Maven，依赖逐项校验。不自动附带 Fabric API 或其他 Mod。
                  </p>
                </>
              )}
              {loader === 'forge' && (
                <>
                  <label className="native-label">
                    Forge 版本
                    <input
                      aria-label="Forge 版本"
                      list="forge-versions"
                      value={forgeVersion}
                      onChange={(event) => setForgeVersion(event.target.value)}
                    />
                  </label>
                  <datalist id="forge-versions">
                    {forgeVersions.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                  <button
                    disabled={locked}
                    onClick={() => {
                      setCatalogRetry((value) => value + 1);
                      setError('');
                    }}
                  >
                    读取 Forge 推荐版本
                  </button>
                  <p className="hint">
                    当前下载并验证官方安装器，不执行补丁处理，不创建可启动的
                    Forge 实例。文件位于数据目录
                    downloads/forge，结果见任务日志。
                  </p>
                </>
              )}
              {loader !== 'forge' && (
                <label className="native-label">
                  实例名称
                  <input
                    aria-label="原版实例名称"
                    maxLength={60}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              <button
                className="primary"
                disabled={
                  locked ||
                  !version.trim() ||
                  (loader !== 'forge' && !name.trim()) ||
                  (loader === 'forge' && !forgeVersion.trim()) ||
                  (loader !== 'vanilla' &&
                    (!loaderReady ||
                      !!loaderCatalog?.error ||
                      !loaderRows.includes(
                        loader === 'forge' ? forgeVersion : fabricVersion,
                      ))) ||
                  ['old_alpha', 'old_beta'].includes(
                    selectedVersion?.type ?? '',
                  )
                }
                onClick={() =>
                  void run(() =>
                    loader === 'forge'
                      ? service.downloadForge(version, forgeVersion)
                      : service.install(
                          version,
                          name,
                          loader === 'fabric' ? fabricVersion : undefined,
                        ),
                  )
                }
              >
                {loader === 'forge'
                  ? '下载 Forge 安装器'
                  : loader === 'fabric'
                    ? '下载并安装 Fabric'
                    : '下载并安装原版'}
              </button>
            </div>

            {selectedVersion &&
              ['old_alpha', 'old_beta'].includes(
                selectedVersion.type ?? '',
              ) && (
                <p role="status">
                  此远古版本仅供浏览，旧式安装与启动尚未支持。
                </p>
              )}
          </div>
          {loader === 'vanilla' ? (
            <div className="official-version-catalog card">
              <div className="section-heading">
                <h3>浏览官方版本</h3>
                <input
                  aria-label="筛选官方版本列表"
                  placeholder="搜索版本号…"
                  value={versionQuery}
                  onChange={(event) => setVersionQuery(event.target.value)}
                />
              </div>
              {catalogError && <p role="alert">{catalogError}</p>}
              {!versions.length && !catalogError && (
                <p className="hint">
                  {snapshot.available
                    ? '正在读取官方版本清单…'
                    : '桌面版从官方清单加载，不显示模拟版本。'}
                </p>
              )}
              {!versionQuery && (
                <section
                  className="latest-official-versions"
                  aria-label="最新官方版本"
                >
                  <h3>最新版本</h3>
                  {['release', 'snapshot'].map((type) => {
                    const entry = versions.find(
                      (entry) => (entry.type ?? 'release') === type,
                    );
                    return entry ? (
                      <button
                        key={type}
                        type="button"
                        aria-label={`选择最新${type === 'release' ? '正式版' : '预览版'} ${entry.id}`}
                        onClick={() => chooseGame(entry.id)}
                      >
                        <span className="version-block-icon">
                          <img
                            src={minecraftIcon}
                            alt=""
                            className="official-provider-icon"
                          />
                        </span>
                        <span>
                          <strong>{entry.id}</strong>
                          <small>
                            {type === 'release' ? '最新正式版' : '最新预览版'} ·{' '}
                            {new Date(entry.releaseTime).toLocaleDateString()}
                          </small>
                        </span>
                      </button>
                    ) : null;
                  })}
                </section>
              )}
              {[
                {
                  name: '正式版',
                  matches: (entry: { type?: string }) =>
                    (entry.type ?? 'release') === 'release',
                },
                {
                  name: '预览版',
                  matches: (entry: { type?: string }) =>
                    entry.type === 'snapshot',
                },
                {
                  name: '远古版',
                  matches: (entry: { type?: string }) =>
                    ['old_alpha', 'old_beta'].includes(entry.type ?? ''),
                },
              ].map((group) => {
                const rows = versions.filter(
                  (entry) =>
                    group.matches(entry) &&
                    entry.id
                      .toLowerCase()
                      .includes(versionQuery.trim().toLowerCase()),
                );
                return (
                  <details
                    key={group.name}
                    open={!!versionQuery || group.name === '正式版'}
                    className="official-version-group"
                  >
                    <summary>
                      {group.name}
                      <small>{rows.length}</small>
                    </summary>
                    <div
                      className="official-version-list"
                      aria-label={`官方${group.name}列表`}
                    >
                      {rows.map((entry) => (
                        <button
                          type="button"
                          key={entry.id}
                          aria-pressed={version === entry.id}
                          onClick={() => chooseGame(entry.id)}
                        >
                          <span className="version-block-icon">
                            <img
                              src={minecraftIcon}
                              alt=""
                              className="official-provider-icon"
                            />
                          </span>
                          <span>
                            <strong>{entry.id}</strong>
                            <small>
                              {entry.releaseTime
                                ? new Date(entry.releaseTime).toLocaleString()
                                : '发布日期未提供'}
                            </small>
                          </span>
                          <span>
                            {version === entry.id ? '已选择' : '选择安装'}
                          </span>
                        </button>
                      ))}
                      {!rows.length && <p className="hint">没有匹配版本。</p>}
                    </div>
                  </details>
                );
              })}
              <p className="hint">
                分类依据官方清单；特殊活动版本归入其官方类别。旧式版本可浏览，安装时仍需满足启动器支持条件。
              </p>
            </div>
          ) : (
            <section
              className="loader-version-catalog card"
              aria-label={`${loaderName} 可下载版本`}
            >
              <div className="section-heading">
                <h3>
                  <img
                    className="official-provider-icon"
                    src={loaderIcon}
                    alt=""
                  />
                  {loaderName} · Minecraft {version}
                </h3>
                <input
                  aria-label={`筛选 ${loaderName} 版本`}
                  placeholder="搜索加载器版本…"
                  value={versionQuery}
                  onChange={(event) => setVersionQuery(event.target.value)}
                />
              </div>
              {!loaderReady ? (
                <p role="status">正在读取 {loaderName} 官方兼容版本…</p>
              ) : loaderCatalog.error ? (
                <div className="notice" role="alert">
                  {loaderCatalog.error}
                  <button onClick={() => setCatalogRetry((value) => value + 1)}>
                    重新读取 {loaderName} 版本
                  </button>
                </div>
              ) : (
                <>
                  <p className="hint">
                    {loader === 'forge'
                      ? '来自 Forge 官方 Maven 目录；仅下载校验安装器。'
                      : '来自 Fabric 官方元数据；默认选择官方稳定推荐版，也可选择其他发布版本。'}
                  </p>
                  <div className="official-version-list loader-version-list">
                    {loaderRows
                      .filter((value) => value.includes(versionQuery.trim()))
                      .map((value) => (
                        <button
                          key={value}
                          type="button"
                          disabled={locked}
                          aria-pressed={
                            (loader === 'forge'
                              ? forgeVersion
                              : fabricVersion) === value
                          }
                          onClick={() =>
                            loader === 'forge'
                              ? setForgeVersion(value)
                              : setFabricVersion(value)
                          }
                        >
                          <img
                            className="official-provider-icon"
                            src={loaderIcon}
                            alt=""
                          />
                          <span>
                            <strong>
                              {loaderName} {value}
                            </strong>
                            <small>
                              Minecraft {version}
                              {loaderCatalog.recommended === value
                                ? ' · 官方推荐'
                                : ''}
                            </small>
                          </span>
                          <span>
                            {(loader === 'forge'
                              ? forgeVersion
                              : fabricVersion) === value
                              ? '已选择'
                              : '选择此版本'}
                          </span>
                        </button>
                      ))}
                  </div>
                  {!loaderRows.length && (
                    <p role="status">
                      该 Minecraft 版本暂没有可用的 {loaderName} 版本。
                    </p>
                  )}
                  {!!loaderRows.length &&
                    !loaderRows.some((value) =>
                      value.includes(versionQuery.trim()),
                    ) && <p>没有匹配的加载器版本。</p>}
                </>
              )}
            </section>
          )}
        </section>
        {!compact && (
          <section className="card">
            <h2>已安装的真实实例</h2>
            <p>
              当前启动身份：
              {state?.settings.launchMode === 'offline'
                ? `离线 · ${state.settings.offlineName}`
                : state?.account
                  ? `Microsoft · ${state.account.name}`
                  : 'Microsoft · 尚未登录'}
              （以已保存配置为准）
            </p>
            <p className="hint">
              此版本关闭启动器时会结束由它启动的游戏，请先保存并退出世界。
            </p>
            {state?.instances.length ? (
              <div className="native-instances">
                {state.instances.map((instance) => (
                  <div key={instance.id}>
                    <div>
                      <strong>{instance.name}</strong>
                      <small>
                        Minecraft {instance.version} · Java {instance.javaMajor}{' '}
                        ·{instanceLoader(instance)} ·{' '}
                        {instance.local
                          ? '引用本地'
                          : instanceIsolated(instance)
                            ? '独立目录'
                            : '共享目录'}
                      </small>
                    </div>
                    <button
                      disabled={
                        locked ||
                        (state.settings.launchMode === 'microsoft' &&
                          !state.account)
                      }
                      onClick={() =>
                        void run(() => service.launch(instance.id))
                      }
                    >
                      <Play size={15} />
                      启动游戏
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p>还没有已安装实例。安装成功后才会出现在这里。</p>
            )}
          </section>
        )}
      </fieldset>
      {!compact && <PackInspector service={service} />}
      {!compact && state && state.task.status !== 'idle' && (
        <section className="card" aria-label="原版任务" ref={taskRef}>
          <h2>
            {state.task.phase === 'game' && active
              ? 'Minecraft 进程运行中'
              : {
                  running: '原版任务进行中',
                  succeeded: '原版任务已完成',
                  failed: '原版任务失败',
                  cancelled: '原版任务已取消',
                  idle: '',
                }[state.task.status]}
          </h2>
          <p role="status">{state.task.message}</p>
          {state.task.total > 0 && (
            <>
              <progress
                aria-label="原版任务进度"
                value={state.task.completed}
                max={state.task.total}
              />
              <p>
                {state.task.completed} / {state.task.total} 个文件或步骤
              </p>
            </>
          )}
          {state.task.pid && <p>游戏进程 PID：{state.task.pid}</p>}
          <details open={state.task.status === 'failed'}>
            <summary>游戏日志（最近 200 条，令牌脱敏）</summary>
            <pre className="diagnostics game-log">
              {state.task.logs.join('\n') || '暂无游戏进程日志'}
            </pre>
          </details>
          {active && (
            <button onClick={() => void run(service.cancel)} disabled={busy}>
              {state.task.phase === 'game' ? '结束游戏进程' : '取消原版任务'}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
