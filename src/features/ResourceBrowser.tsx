import { useEffect, useRef, useState } from 'react';
import type {
  NativeService,
  ResourceDetail,
  ResourceKind,
  ResourceSearch,
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
  target,
}: {
  service: NativeService;
  kind: ResourceKind;
  query: string;
  gameVersion: string;
  onFilter(query: string, gameVersion: string): void;
  target?: string;
}) {
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
    } catch (error) {
      if (ticket === request.current)
        setError(error instanceof Error ? error.message : '读取详情失败');
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  const selected = detail?.versions.find((version) => version.id === versionId);
  return (
    <section className="resource-browser">
      <p className="hint">
        来源：Modrinth · 当前目标：{target || '尚未选择实例，可先浏览'}。
        {kind === 'mod' ? '本轮模组筛选使用 Fabric。' : ''}
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
      {busy && <p role="status">正在查询 Modrinth…</p>}
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
                    onChange={(event) => setVersionId(event.target.value)}
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
            <p className="notice">
              真实搜索与版本查询已接入。安装事务、依赖解析和校验提交仍在实现中；当前不会修改游戏文件。
            </p>
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
