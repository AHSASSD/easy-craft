import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Box, Download, Play, ShieldCheck } from 'lucide-react';
import type { NativeService, NativeSettings } from '../core/native-contracts';
import { PackInspector } from './PackInspector';
import { DownSelect } from '../components/DownSelect';

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
    { id: string; releaseTime: string }[]
  >([]);
  const [versionQuery, setVersionQuery] = useState('');
  const [visibleVersions, setVisibleVersions] = useState(20);
  const [catalogError, setCatalogError] = useState('');
  const [version, setVersion] = useState('1.21.1');
  const [loader, setLoader] = useState('vanilla');
  const [fabricVersion, setFabricVersion] = useState('0.16.14');
  const [fabricVersions, setFabricVersions] = useState<string[]>([]);
  const [name, setName] = useState('我的原版世界');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const state = snapshot.state;
  const catalogRequest = useRef(0);
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
      <div className="eyebrow">VANILLA / 原版旅程</div>
      <h1>{compact ? '原版游戏' : '原版下载与启动'}</h1>
      <p>
        从官方来源安装独立实例，支持原版与 Fabric。安装成功后在游戏库中启动。
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
        <section className="card">
          <div className="section-heading">
            <h2>
              <Download size={17} />
              安装原版实例
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
                }, '已读取官方正式版本清单。')
              }
            >
              刷新官方版本
            </button>
          </div>
          <p>
            下载只来自官方资源域名，逐文件校验 SHA-1。V0.3 支持现代原版与
            Fabric；旧式参数和其他加载器暂不支持。
          </p>
          <div className="official-version-catalog">
            <div className="section-heading">
              <h3>正式版本</h3>
              <input
                aria-label="筛选官方版本列表"
                placeholder="输入版本号，或直接选择下方版本"
                value={versionQuery}
                onChange={(event) => {
                  setVersionQuery(event.target.value);
                  setVisibleVersions(20);
                }}
              />
            </div>
            {catalogError && <p role="alert">{catalogError}</p>}
            {!versions.length && !catalogError && (
              <p className="hint">
                {snapshot.available
                  ? '正在读取官方版本清单，可点击刷新重试。'
                  : '桌面版从官方清单加载版本，不显示模拟版本。'}
              </p>
            )}
            <div
              className="official-version-list"
              aria-label="官方正式版本列表"
            >
              {versions
                .filter((entry) => entry.id.includes(versionQuery.trim()))
                .slice(0, visibleVersions)
                .map((entry, index) => (
                  <button
                    type="button"
                    key={entry.id}
                    aria-pressed={version === entry.id}
                    onClick={() => setVersion(entry.id)}
                  >
                    <span className="version-block-icon">
                      <Box size={24} />
                    </span>
                    <span>
                      <strong>{entry.id}</strong>
                      <small>
                        {entry.releaseTime
                          ? new Date(entry.releaseTime).toLocaleString()
                          : '官方正式版'}
                        {index === 0 && !versionQuery ? ' · 最新正式版' : ''}
                      </small>
                    </span>
                    <span>{version === entry.id ? '已选择' : '选择安装'}</span>
                  </button>
                ))}
            </div>
            {versions.filter((entry) => entry.id.includes(versionQuery.trim()))
              .length > visibleVersions && (
              <button
                type="button"
                onClick={() => setVisibleVersions((count) => count + 20)}
              >
                显示更多正式版
              </button>
            )}
          </div>
          <label className="native-label">
            正式版本
            <DownSelect
              label="原版版本"
              value={version}
              options={versions.map((entry) => ({
                value: entry.id,
                label: entry.id,
              }))}
              onChange={setVersion}
              allowCustom
              disabled={locked}
            />
          </label>
          <label className="native-label">
            加载器
            <select
              aria-label="真实实例加载器"
              value={loader}
              onChange={(event) => setLoader(event.target.value)}
            >
              <option value="vanilla">原版</option>
              <option value="fabric">Fabric</option>
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
                onClick={() =>
                  void run(
                    async () =>
                      setFabricVersions(await service.fabricVersions(version)),
                    '已读取 Fabric 稳定版本。',
                  )
                }
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
          <label className="native-label">
            实例名称
            <input
              aria-label="原版实例名称"
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={locked || !version.trim() || !name.trim()}
            onClick={() =>
              void run(() =>
                service.install(
                  version,
                  name,
                  loader === 'fabric' ? fabricVersion : undefined,
                ),
              )
            }
          >
            {loader === 'fabric' ? '下载并安装 Fabric' : '下载并安装原版'}
          </button>
          <p className="hint">
            取消后保留缓存；再次点击可复用已校验文件并续传未完成资源。安装不要求先登录；可选择离线账户或
            Microsoft 账户启动，均需匹配版本的 64 位 Java。
          </p>
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
                        ·
                        {instance.fabricVersion
                          ? `Fabric ${instance.fabricVersion}`
                          : '原版'}{' '}
                        · 独立目录
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
