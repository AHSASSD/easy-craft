import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { Download, Play, ShieldCheck, UserRound } from 'lucide-react';
import type { NativeService, NativeSettings } from '../core/native-contracts';

export function NativeWorkspace({ service }: { service: NativeService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.snapshot);
  const [draft, setDraft] = useState<NativeSettings | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('1.21.1');
  const [name, setName] = useState('我的原版世界');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const state = snapshot.state;
  const settings = draft ??
    state?.settings ?? { clientId: '', javaPath: '', memoryMb: 2048 };
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
      await service.saveSettings(settings);
      setDraft(null);
    }, '原生配置已保存。');
  }
  return (
    <div className="native-workspace">
      <div className="eyebrow">VANILLA / 原版旅程</div>
      <h1>原版下载与启动</h1>
      <p>V0.2 · 此处执行真实下载和游戏进程；左侧样例实例仍使用模拟流程。</p>
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
            <label>
              最大内存（MB）
              <input
                aria-label="最大内存"
                type="number"
                min={512}
                max={16384}
                step={256}
                required
                value={settings.memoryMb}
                onChange={(event) =>
                  setDraft({
                    ...settings,
                    memoryMb: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              Microsoft 应用 Client ID
              <input
                aria-label="Microsoft 应用 Client ID"
                value={settings.clientId}
                placeholder="自有应用的 Client ID（无需 Client Secret）"
                onChange={(event) =>
                  setDraft({ ...settings, clientId: event.target.value.trim() })
                }
              />
            </label>
            <p className="hint">
              Client ID 需支持个人账户、公共客户端设备授权，并获准访问 Minecraft
              API。不要填写密码、Client Secret 或令牌。更换 ID
              前需退出当前账户。
            </p>
            <button className="primary" type="submit" disabled={locked}>
              保存原生配置
            </button>
          </form>
          {state && <p className="data-root">数据目录：{state.dataRoot}</p>}
        </section>
        <section className="card">
          <h2>
            <UserRound size={17} />
            正版账户
          </h2>
          {state?.account ? (
            <>
              <p>
                已授权：<strong>{state.account.name}</strong>
              </p>
              <p className="hint">
                刷新令牌由原生端使用 Windows DPAPI 加密，只能由当前 Windows
                用户解密。网页不接收访问令牌。
              </p>
              <button
                disabled={locked}
                onClick={() =>
                  void run(service.signOut, '本地加密账户凭据已删除。')
                }
              >
                退出正版账户
              </button>
            </>
          ) : (
            <>
              <p>请使用拥有 Minecraft Java 正版档案的 Microsoft 账户。</p>
              <button
                disabled={locked || !state?.settings.clientId}
                onClick={() => void run(service.beginLogin)}
              >
                获取 Microsoft 登录设备码
              </button>
            </>
          )}
          {state?.loginPending && (
            <div className="device-login">
              {state.loginCode ? (
                <>
                  <p>
                    在系统浏览器访问 <strong>https://microsoft.com/link</strong>{' '}
                    并输入：
                  </p>
                  <code className="device-code">
                    {state.loginCode.userCode}
                  </code>
                  <p>
                    约 {Math.ceil(state.loginCode.expiresIn / 60)}{' '}
                    分钟后过期；授权结果会自动更新，切换页面不影响登录。
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => void run(service.openLogin)}
                  >
                    打开 Microsoft 登录网页
                  </button>
                </>
              ) : (
                <p>正在完成 Microsoft / Xbox / Minecraft 认证…</p>
              )}
              <button
                disabled={busy}
                onClick={() => void run(service.cancelLogin)}
              >
                取消本次登录
              </button>
            </div>
          )}
        </section>
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
                  const values = await service.versions();
                  setVersions(values);
                }, '已读取官方正式版本清单。')
              }
            >
              刷新官方版本
            </button>
          </div>
          <p>
            下载只来自官方资源域名，逐文件校验 SHA-1。V0.2
            支持现代原版格式；旧式参数、继承版本与加载器暂不支持。
          </p>
          <label className="native-label">
            正式版本
            <input
              aria-label="原版版本"
              list="official-versions"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
            />
            <datalist id="official-versions">
              {versions.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </label>
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
            onClick={() => void run(() => service.install(version, name))}
          >
            下载并安装原版
          </button>
          <p className="hint">
            取消后保留缓存；再次点击可复用已校验文件并续传未完成资源。安装不要求先登录，真正启动需要正版授权和匹配版本的
            64 位 Java。
          </p>
        </section>
        <section className="card">
          <h2>已安装的真实实例</h2>
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
                      Minecraft {instance.version} · Java {instance.javaMajor} ·
                      独立目录
                    </small>
                  </div>
                  <button
                    disabled={locked || !state.account}
                    onClick={() => void run(() => service.launch(instance.id))}
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
      </fieldset>
      {state && state.task.status !== 'idle' && (
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
