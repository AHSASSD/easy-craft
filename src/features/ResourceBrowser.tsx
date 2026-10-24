import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  NativeService,
  ResourceDetail,
  ResourceKind,
  ResourceSearch,
  ResourcePlan,
  WorldEntry,
} from '../core/native-contracts';

const dependencyNames: Record<string, string> = {
  required: '必需',
  optional: '可选',
  incompatible: '不兼容',
  embedded: '已内置',
};
const environments: Record<string, string> = {
  unknown: '未标明',
  client_only: '仅客户端',
  server_only: '服务器或单人世界',
  dedicated_server_only: '仅独立服务器',
  client_or_server: '客户端或服务器',
  client_and_server: '客户端与服务器均需',
};
export function ResourceBrowser({
  service,
  kind,
  query,
  gameVersion,
  onFilter,
  selectedId,
  worldSelection,
  onWorldSelection,
}: {
  service: NativeService;
  kind: ResourceKind;
  query: string;
  gameVersion: string;
  onFilter(query: string, gameVersion: string): void;
  selectedId?: string;
  worldSelection?: Record<string, string>;
  onWorldSelection?(id: string, world: string): void;
}) {
  const native = useSyncExternalStore(service.subscribe, service.snapshot);
  const [targetId, setTargetId] = useState(
    selectedId ?? native.state?.instances[0]?.id ?? '',
  );
  const [file, setFile] = useState('');
  const [worlds, setWorlds] = useState<WorldEntry[]>([]);
  const [worldId, setWorldId] = useState(
    worldSelection?.[selectedId ?? native.state?.instances[0]?.id ?? ''] ?? '',
  );
  const [plan, setPlan] = useState<ResourcePlan | null>(null);
  const [closed, setClosed] = useState(false);
  const [message, setMessage] = useState('');
  const installing = native.state?.task.status === 'running';
  const [result, setResult] = useState<{
    value: ResourceSearch;
    query: string;
    game: string;
    time: string;
  } | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [versionId, setVersionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    if (kind !== 'datapack' || !targetId || installing || !native.available)
      return;
    let disposed = false;
    void service
      .worlds(targetId)
      .then((entries) => {
        if (disposed) return;
        setWorlds(entries);
        setWorldId((current) =>
          entries.some((world) => world.id === current) ? current : '',
        );
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : '世界列表读取失败');
      });
    return () => {
      disposed = true;
    };
  }, [service, targetId, kind, installing, native.available]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function search(offset = 0) {
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const value = await service.searchResources(
        kind,
        query,
        gameVersion,
        offset,
      );
      if (ticket !== request.current) return;
      setResult({
        value,
        query,
        game: gameVersion,
        time: new Date().toLocaleTimeString(),
      });
      setDetail(null);
      setPlan(null);
    } catch (error) {
      if (ticket === request.current)
        setError(error instanceof Error ? error.message : '搜索失败');
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  async function open(project: string) {
    if (!result) return;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const value = await service.resourceDetail(project, kind, result.game);
      if (ticket !== request.current) return;
      setDetail(value);
      setVersionId(value.versions[0]?.id ?? '');
      setFile(value.versions[0]?.files[0]?.filename ?? '');
      setPlan(null);
      setMessage('');
      setClosed(false);
    } catch (error) {
      if (ticket === request.current)
        setError(error instanceof Error ? error.message : '读取详情失败');
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  const selected = detail?.versions.find((version) => version.id === versionId);
  async function previewInstall() {
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    setPlan(null);
    setMessage('');
    try {
      const value = await service.planResources(
        targetId,
        kind,
        versionId,
        file,
        kind === 'datapack' ? worldId : undefined,
      );
      if (ticket === request.current) {
        setPlan(value);
        setClosed(false);
      }
    } catch (error) {
      if (ticket === request.current)
        setError(error instanceof Error ? error.message : '预览失败');
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  async function install() {
    if (!plan || !closed) return;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      await service.installResources(plan.token);
      if (ticket === request.current) {
        setPlan(null);
        setMessage('资源安装任务已开始，请在底部查看真实进度与结果。');
      }
    } catch (error) {
      if (ticket === request.current)
        setError(error instanceof Error ? error.message : '启动安装失败');
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  return (
    <section className="resource-browser">
      <p className="hint">
        来源：Modrinth · 当前目标：
        {native.state?.instances.find((item) => item.id === targetId)?.name ||
          '尚未选择实例，可先浏览'}
        。{kind === 'mod' ? '本轮模组筛选使用 Fabric。' : ''}
      </p>
      <form
        className="content-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="搜索在线资源"
          placeholder="搜索项目名称…"
          maxLength={256}
          value={query}
          onChange={(event) => onFilter(event.target.value, gameVersion)}
        />
        <label>
          游戏版本{' '}
          <input
            aria-label="在线资源游戏版本"
            maxLength={100}
            value={gameVersion}
            onChange={(event) => onFilter(query, event.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy || !service.snapshot().available || !gameVersion}
        >
          搜索资源
        </button>
      </form>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {busy && <p role="status">正在处理资源请求…</p>}
      {!service.snapshot().available && (
        <p className="notice">在线资源查询需要桌面版。</p>
      )}
      {detail ? (
        <>
          <button
            onClick={() => {
              request.current++;
              setBusy(false);
              setDetail(null);
              setError('');
              setPlan(null);
              setMessage('');
            }}
          >
            返回搜索结果
          </button>
          <article className="card resource-detail">
            <h2>{detail.title}</h2>
            <p>{detail.description}</p>
            <p className="hint">
              Modrinth 项目 ID：{detail.id} · 游戏版本：{result?.game}
            </p>
            <details>
              <summary>项目介绍（原文）</summary>
              <div className="resource-description">
                {detail.body || '作者未提供介绍。'}
              </div>
            </details>
            {detail.versions.length ? (
              <>
                <label className="field-label">
                  兼容版本
                  <select
                    aria-label="在线资源兼容版本"
                    value={versionId}
                    disabled={busy}
                    onChange={(event) => {
                      const id = event.target.value;
                      setVersionId(id);
                      setFile(
                        detail.versions.find((v) => v.id === id)?.files[0]
                          ?.filename ?? '',
                      );
                      setPlan(null);
                      setClosed(false);
                    }}
                  >
                    {detail.versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.name} · {version.number}
                      </option>
                    ))}
                  </select>
                </label>
                {selected && (
                  <>
                    <p>
                      格式/加载器：{selected.loaders.join('、')} · 环境：
                      {environments[selected.environment] ??
                        selected.environment}
                    </p>
                    <h3>版本文件</h3>
                    <ul>
                      {selected.files.map((file) => (
                        <li key={file.filename}>
                          {file.filename} ·{' '}
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                          <small className="resource-hash">
                            SHA-1：{file.sha1}
                          </small>
                        </li>
                      ))}
                    </ul>
                    <h3>声明的依赖与冲突</h3>
                    {selected.dependencies.length ? (
                      <ul>
                        {selected.dependencies.map((dep, index) => (
                          <li key={index}>
                            {dependencyNames[dep.kind]}：
                            {dep.projectId || '项目未标明'}
                            {dep.versionId
                              ? ` · 固定版本 ${dep.versionId}`
                              : ' · 未固定版本'}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        此版本 API
                        未列出额外项目依赖；加载器与运行条件仍需检查。
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="notice">
                此项目没有匹配当前游戏版本与资源格式的文件，请修改版本后重新搜索。
              </p>
            )}
            {['mod', 'resourcepack', 'shader', 'datapack'].includes(kind) &&
            selected ? (
              <section className="resource-install">
                <h3>安装到实例</h3>
                <label className="field-label">
                  目标实例
                  <select
                    aria-label="资源安装目标实例"
                    disabled={busy || installing}
                    value={targetId}
                    onChange={(event) => {
                      if (event.target.value === targetId) return;
                      setTargetId(event.target.value);
                      setWorldId(worldSelection?.[event.target.value] ?? '');
                      setWorlds([]);
                      setPlan(null);
                      setClosed(false);
                    }}
                  >
                    <option value="">请选择实例</option>
                    {native.state?.instances.map((instance) => (
                      <option value={instance.id} key={instance.id}>
                        {instance.name} · {instance.version} ·{' '}
                        {instance.fabricVersion ? 'Fabric' : '原版'}
                      </option>
                    ))}
                  </select>
                </label>
                {kind === 'datapack' && (
                  <label className="field-label">
                    目标世界
                    <select
                      aria-label="数据包目标世界"
                      value={worldId}
                      disabled={busy || installing || !targetId}
                      onChange={(event) => {
                        setWorldId(event.target.value);
                        onWorldSelection?.(targetId, event.target.value);
                        setPlan(null);
                        setClosed(false);
                      }}
                    >
                      <option value="">请选择具体世界</option>
                      {worlds.map((world) => (
                        <option key={world.id} value={world.id}>
                          {world.name}
                        </option>
                      ))}
                    </select>
                    {!worlds.length && (
                      <small>
                        此实例没有可安装数据包的世界，先在游戏中创建世界。
                      </small>
                    )}
                  </label>
                )}
                <label className="field-label">
                  版本文件
                  <select
                    aria-label="资源安装文件"
                    disabled={busy}
                    value={file}
                    onChange={(event) => {
                      setFile(event.target.value);
                      setPlan(null);
                      setClosed(false);
                    }}
                  >
                    {selected.files.map((f) => (
                      <option key={f.filename} value={f.filename}>
                        {f.filename}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={
                    busy ||
                    installing ||
                    !targetId ||
                    !file ||
                    (kind === 'datapack' &&
                      !worlds.some((world) => world.id === worldId))
                  }
                  onClick={() => void previewInstall()}
                >
                  预览安装变更
                </button>
                {plan && (
                  <section className="notice" aria-label="资源安装变更预览">
                    <h3>将写入 Minecraft {plan.gameVersion} 的文件</h3>
                    {plan.worldId && (
                      <p>
                        仅安装到世界：{plan.worldId} · 数据包格式{' '}
                        {plan.dataFormat?.join('.')}
                      </p>
                    )}
                    <ul>
                      {plan.files.map((f) => (
                        <li key={f.path}>
                          {f.action === 'keep' ? '保留已有' : '新增'}：{f.path}{' '}
                          · {(f.size / 1024 / 1024).toFixed(2)} MB
                          <details>
                            <summary>来源与校验信息</summary>
                            <small className="resource-hash">
                              项目 {f.project} / 版本 {f.version} · SHA-512{' '}
                              {f.sha512}
                            </small>
                          </details>
                        </li>
                      ))}
                    </ul>
                    {plan.warnings.map((warning, index) => (
                      <p key={index}>{warning}</p>
                    ))}
                    <label className="toggle-row">
                      <span>我已退出目标实例的游戏并检查以上变更</span>
                      <input
                        aria-label="确认在线安装前游戏已关闭"
                        type="checkbox"
                        disabled={busy || installing}
                        checked={closed}
                        onChange={(event) => setClosed(event.target.checked)}
                      />
                    </label>
                    <button
                      disabled={busy || installing || !closed}
                      onClick={() => void install()}
                    >
                      确认安装资源
                    </button>
                  </section>
                )}
                <p className="hint">
                  安装前再次检查目标内容与 JAR
                  声明条件；同名不同内容或依赖冲突会拒绝提交。下载资源包/光影包不会自动在游戏中启用。
                </p>
              </section>
            ) : (
              <p className="notice">
                {kind === 'modpack'
                  ? '在线整合包安装尚未接入。已有 ZIP/MRPACK 可在下方检查，支持的包可新建实例。'
                  : '此版本暂没有可用的安装路径，请检查兼容条件。'}
              </p>
            )}
          </article>
        </>
      ) : result ? (
        <>
          <p className="hint">
            结果：{result.query || '全部项目'} · Minecraft {result.game} · 共{' '}
            {result.value.total} 项 · 查询于 {result.time}
            {result.query !== query || result.game !== gameVersion
              ? ' · 筛选已修改，请重新搜索'
              : ''}
          </p>
          {result.value.hits.length ? (
            result.value.hits.map((hit) => (
              <article className="card resource-hit" key={hit.id}>
                <h2>{hit.title}</h2>
                <p>{hit.description}</p>
                <div className="content-toolbar">
                  <span>作者：{hit.author}</span>
                  <button disabled={busy} onClick={() => void open(hit.id)}>
                    查看 {hit.title}
                  </button>
                </div>
              </article>
            ))
          ) : (
            <section className="card">
              <p>没有匹配的资源，可以调整名称或游戏版本。</p>
            </section>
          )}
          <div className="content-toolbar">
            <button
              disabled={
                busy ||
                result.value.offset === 0 ||
                result.query !== query ||
                result.game !== gameVersion
              }
              onClick={() => void search(Math.max(0, result.value.offset - 20))}
            >
              上一页资源
            </button>
            <span>第 {Math.floor(result.value.offset / 20) + 1} 页</span>
            <button
              disabled={
                busy ||
                result.value.offset + 20 >= result.value.total ||
                result.value.offset >= 10000 ||
                result.query !== query ||
                result.game !== gameVersion
              }
              onClick={() => void search(result.value.offset + 20)}
            >
              下一页资源
            </button>
          </div>
        </>
      ) : (
        <section className="card">
          <p>
            输入名称与游戏版本后搜索真实资源。结果与文件信息以来源接口为准。
          </p>
        </section>
      )}
    </section>
  );
}
