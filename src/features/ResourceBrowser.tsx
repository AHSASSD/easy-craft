import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  NativeService,
  ResourceDetail,
  ResourceKind,
  ResourceSearch,
  ResourcePlan,
  WorldEntry,
  ResourceSource,
  ResourceVersion,
} from '../core/native-contracts';
import { Modal } from '../components/Modal';
import { PackInspector } from './PackInspector';
import { DownSelect } from '../components/DownSelect';
import { InstallPreflight } from './InstallPreflight';
import { instanceLoader } from '../core/instance-settings';
import { Package } from 'lucide-react';

const dependencyNames: Record<string, string> = {
  required: '必需',
  optional: '可选',
  incompatible: '不兼容',
  embedded: '已内置',
};
function displayDate(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未提供日期';
  return new Date(value).toLocaleDateString();
}
function gameMajor(game: string) {
  return game.match(/^(\d+\.\d+)(?:\.|$)/)?.[1] ?? '预览与特殊版本';
}
function versionGroups(versions: ResourceVersion[], fallback: string) {
  const groups = new Map<string, ResourceVersion[]>();
  for (const version of versions) {
    for (const major of new Set(
      (version.gameVersions?.length ? version.gameVersions : [fallback]).map(
        gameMajor,
      ),
    )) {
      const rows = groups.get(major) ?? [];
      rows.push(version);
      groups.set(major, rows);
    }
  }
  return [...groups].sort(([a], [b]) =>
    b.localeCompare(a, 'en', { numeric: true }),
  );
}
function displayDownloads(value?: number | null) {
  return value == null
    ? '下载量未提供'
    : `${new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)} 次下载`;
}
const environments: Record<string, string> = {
  unknown: '未标明',
  client_only: '仅客户端',
  server_only: '服务器或单人世界',
  dedicated_server_only: '仅独立服务器',
  client_or_server: '客户端或服务器',
  client_and_server: '客户端与服务器均需',
};
const categoryLabels: Record<string, string> = {
  optimization: '性能优化',
  technology: '科技',
  adventure: '冒险',
  decoration: '装饰',
  library: '前置库',
  utility: '实用工具',
  magic: '魔法',
  worldgen: '世界生成',
  storage: '存储',
  equipment: '装备',
  food: '食物',
  mobs: '生物',
  'game-mechanics': '游戏机制',
  transportation: '交通',
  management: '管理',
  realistic: '写实',
  simplistic: '简约',
  'vanilla-like': '原版风格',
  themed: '主题',
  tweaks: '细节调整',
  gui: '界面',
  audio: '音效',
  blocks: '方块',
  entities: '实体',
  items: '物品',
  fonts: '字体',
  environment: '环境',
  models: '模型',
  locale: '语言',
  combat: '战斗',
  lightweight: '轻量',
  multiplayer: '多人',
  quests: '任务',
  challenging: '挑战',
  atmosphere: '氛围',
  cartoon: '卡通',
  fantasy: '奇幻',
  low: '低配置',
  medium: '中等配置',
  high: '高配置',
  reflections: '反射',
  shadows: '阴影',
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
  incomingPack,
  onPackConsumed,
}: {
  service: NativeService;
  kind: ResourceKind;
  query: string;
  gameVersion: string;
  onFilter(query: string, gameVersion: string): void;
  selectedId?: string;
  worldSelection?: Record<string, string>;
  onWorldSelection?(id: string, world: string): void;
  incomingPack?: File | null;
  onPackConsumed?(): void;
}) {
  const native = useSyncExternalStore(service.subscribe, service.snapshot);
  const [source, setSource] = useState<ResourceSource>('modrinth');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const sourceName = source === 'curseforge' ? 'CurseForge' : 'Modrinth';
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
  const [acknowledgeIssues, setAcknowledgeIssues] = useState(false);
  const [message, setMessage] = useState('');
  const installing = native.state?.task.status === 'running';
  const [result, setResult] = useState<{
    value: ResourceSearch;
    query: string;
    game: string;
    time: string;
    category: string;
    index: string;
    source: ResourceSource;
  } | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [catalogPhase, setCatalogPhase] = useState<
    'complete' | 'loading' | 'failed'
  >('complete');
  const [catalogError, setCatalogError] = useState('');
  const [targetOpen, setTargetOpen] = useState(false);
  const [saveOnly, setSaveOnly] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('');
  const [index, setIndex] = useState(query ? 'relevance' : 'downloads');
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryError, setCategoryError] = useState('');
  const [gameVersions, setGameVersions] = useState<string[]>([]);
  const [versionsError, setVersionsError] = useState('');
  const request = useRef(0);
  const catalogRequest = useRef(0);
  const browserRoot = useRef<HTMLElement>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const initialSearch = useEffectEvent(() => {
    if (gameVersion) void search();
  });
  const filterSignature = JSON.stringify([
    query,
    gameVersion,
    category,
    index,
    source,
  ]);
  const previousFilters = useRef(filterSignature);
  useEffect(() => {
    if (previousFilters.current === filterSignature) return;
    previousFilters.current = filterSignature;
    if (!native.available || !gameVersion) return;
    searchTimer.current = window.setTimeout(() => initialSearch(), 450);
    const timeout = searchTimer.current;
    return () => window.clearTimeout(timeout);
  }, [filterSignature, native.available, gameVersion]);
  useEffect(() => {
    if (!native.available) return;
    initialSearch();
    let disposed = false;
    void service
      .versions()
      .then((values) => {
        if (!disposed) setGameVersions(values);
      })
      .catch(() => {
        if (!disposed)
          setVersionsError('游戏版本清单加载失败，仍可在下拉框输入版本。');
      });
    void service
      .resourceCategories(kind)
      .then((value) => {
        if (!disposed) setCategories(value);
      })
      .catch(() => {
        if (!disposed)
          setCategoryError('分类加载失败，可继续搜索或重新进入此分类重试。');
      });
    return () => {
      disposed = true;
    };
  }, [service, kind, native.available]);
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
      catalogRequest.current++;
    },
    [],
  );
  async function search(offset = 0) {
    window.clearTimeout(searchTimer.current);
    catalogRequest.current++;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      const value = await service.searchResources(
        kind,
        query,
        gameVersion,
        offset,
        { category, index, ...(source === 'curseforge' ? { source } : {}) },
      );
      if (ticket !== request.current) return;
      setResult({
        value,
        query,
        game: gameVersion,
        time: new Date().toLocaleTimeString(),
        category,
        index,
        source,
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
  async function finishCatalog(task: Promise<ResourceDetail>, ticket: number) {
    setCatalogPhase('loading');
    setCatalogError('');
    try {
      const value = await task;
      if (ticket !== catalogRequest.current) return;
      // Keep the player's version/file choice and frozen install preview intact.
      setDetail(value);
      setCatalogPhase('complete');
    } catch (error) {
      if (ticket !== catalogRequest.current) return;
      setCatalogPhase('failed');
      setCatalogError(
        error instanceof Error ? error.message : '版本列表加载失败',
      );
    }
  }
  async function open(project: string) {
    if (!result) return;
    const ticket = ++request.current;
    const catalogTicket = ++catalogRequest.current;
    setBusy(true);
    setError('');
    setCatalogError('');
    try {
      const quick =
        result.source === 'modrinth'
          ? service.resourceDetail(project, kind, result.game)
          : null;
      const full = service.resourceDetail(project, kind, result.game, {
        allVersions: true,
        ...(result.source === 'curseforge' ? { source: result.source } : {}),
      });
      // Race successful results: a warm full catalog must not wait for a cold filtered query.
      const first = await Promise.any([
        full.then((value) => ({ value, complete: true })),
        ...(quick ? [quick.then((value) => ({ value, complete: false }))] : []),
      ]);
      if (ticket !== request.current) return;
      const { value } = first;
      setDetail(value);
      setCatalogPhase(first.complete ? 'complete' : 'loading');
      const initial =
        value.versions.find((version) =>
          version.gameVersions?.includes(result.game),
        ) ?? value.versions[0];
      setVersionId(initial?.id ?? '');
      setOpenGroups({ [gameMajor(result.game)]: true });
      setFile(
        initial?.files.find(
          (file) =>
            kind !== 'modpack' || /\.(mrpack|zip)$/i.test(file.filename),
        )?.filename ?? '',
      );
      setPlan(null);
      setMessage('');
      setClosed(false);
      setAcknowledgeIssues(false);
      if (!first.complete) void finishCatalog(full, catalogTicket);
      browserRoot.current
        ?.closest<HTMLElement>('.library-content')
        ?.scrollTo({ top: 0 });
    } catch (error) {
      if (ticket === request.current)
        setError(
          error instanceof AggregateError
            ? error.errors
                .map((item) =>
                  item instanceof Error ? item.message : String(item),
                )
                .join('；')
            : error instanceof Error
              ? error.message
              : '读取详情失败',
        );
    } finally {
      if (ticket === request.current) setBusy(false);
    }
  }
  const selected = detail?.versions.find((version) => version.id === versionId);
  function chooseVersion(id: string) {
    setTargetOpen(kind !== 'modpack');
    setVersionId(id);
    setFile(
      detail?.versions
        .find((v) => v.id === id)
        ?.files.find(
          (file) =>
            kind !== 'modpack' || /\.(mrpack|zip)$/i.test(file.filename),
        )?.filename ?? '',
    );
    setPlan(null);
    setClosed(false);
    setAcknowledgeIssues(false);
  }
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
        source === 'curseforge' ? source : undefined,
        source === 'curseforge' ? detail?.id : undefined,
      );
      if (ticket === request.current) {
        setPlan(value);
        setAcknowledgeIssues(false);
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
    if (
      !plan ||
      !closed ||
      (plan.preflight?.issues.length && !acknowledgeIssues) ||
      (kind === 'mod' && !plan.preflight)
    )
      return;
    const ticket = ++request.current;
    setBusy(true);
    setError('');
    try {
      await service.installResources(
        plan.token,
        !!plan.preflight?.issues.length && acknowledgeIssues,
      );
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
    <section className="resource-browser" ref={browserRoot}>
      {!detail && (
        <div className="resource-search-dock">
          <p className="hint">
            来源：{sourceName} ·{' '}
            {kind === 'modpack' ? (
              '安装目标：全新实例'
            ) : (
              <>
                当前目标：
                {native.state?.instances.find((item) => item.id === targetId)
                  ?.name || '尚未选择实例，可先浏览'}
              </>
            )}
            。{kind === 'mod' ? '本轮模组筛选使用 Fabric。' : ''}
          </p>
          {kind === 'mod' && (
            <div className="resource-source-tabs" aria-label="资源来源">
              {(['modrinth', 'curseforge'] as const).map((value) => (
                <button
                  key={value}
                  disabled={busy}
                  aria-pressed={source === value}
                  onClick={() => {
                    setSource(value);
                    setCategory('');
                    setResult(null);
                    setDetail(null);
                    setPlan(null);
                    setError('');
                  }}
                >
                  {value === 'modrinth' ? 'Modrinth' : 'CurseForge'}
                </button>
              ))}
            </div>
          )}
          <form
            className="resource-search-form card"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <label className="resource-query-field">
              名称关键词
              <input
                aria-label="搜索在线资源"
                placeholder="输入部分名称或关键词…"
                maxLength={256}
                value={query}
                onChange={(event) => onFilter(event.target.value, gameVersion)}
              />
            </label>
            <label>
              游戏版本{' '}
              <DownSelect
                label="在线资源游戏版本"
                value={gameVersion}
                options={gameVersions.map((value) => ({ value, label: value }))}
                onChange={(value) => onFilter(query, value)}
                allowCustom
              />
            </label>
            <label>
              分类
              <DownSelect
                label="在线资源分类"
                disabled={source === 'curseforge'}
                value={category}
                onChange={setCategory}
                options={[
                  { value: '', label: '全部分类' },
                  ...categories.map((value) => ({
                    value,
                    label: categoryLabels[value]
                      ? `${categoryLabels[value]} · ${value}`
                      : value,
                  })),
                ]}
              />
            </label>
            <label>
              排序
              <DownSelect
                label="在线资源排序"
                value={index}
                onChange={setIndex}
                options={[
                  { value: 'relevance', label: '相关程度' },
                  { value: 'downloads', label: '下载最多' },
                  { value: 'updated', label: '最近更新' },
                  { value: 'newest', label: '最新发布' },
                ]}
              />
            </label>
            <div className="button-row resource-search-actions">
              <button
                type="submit"
                disabled={busy || !service.snapshot().available || !gameVersion}
              >
                搜索资源
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onFilter('', gameVersion);
                  setCategory('');
                  setIndex('downloads');
                }}
              >
                重置条件
              </button>
            </div>
          </form>
        </div>
      )}
      {categoryError && (
        <p className="hint" role="status">
          {categoryError}
        </p>
      )}
      {versionsError && (
        <p className="hint" role="status">
          {versionsError}
        </p>
      )}
      {error && !targetOpen && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && !targetOpen && (
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
              catalogRequest.current++;
              setBusy(false);
              setDetail(null);
              setError('');
              setPlan(null);
              setMessage('');
            }}
          >
            返回搜索结果
          </button>
          <article
            className="card resource-detail"
            data-catalog-pending={catalogPhase === 'loading'}
          >
            <h2>{detail.title}</h2>
            <p>{detail.description}</p>
            <p className="hint">
              {sourceName} · Minecraft {result?.game}
            </p>
            <details>
              <summary>项目介绍（原文）</summary>
              <div className="resource-description">
                {detail.body || '作者未提供介绍。'}
              </div>
            </details>
            {catalogPhase === 'loading' && (
              <p className="hint" role="status">
                其他游戏版本正在后台加载，当前版本可直接选择。
              </p>
            )}
            {catalogPhase === 'failed' && (
              <div className="notice resource-catalog-error" role="alert">
                <p>
                  其他游戏版本加载失败：{catalogError}
                  。当前已加载的版本仍可选择。
                </p>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (!result) return;
                    void finishCatalog(
                      service.resourceDetail(detail.id, kind, result.game, {
                        allVersions: true,
                        ...(result.source === 'curseforge'
                          ? { source: result.source }
                          : {}),
                      }),
                      ++catalogRequest.current,
                    );
                  }}
                >
                  重试加载其他版本
                </button>
              </div>
            )}
            {detail.versions.length ? (
              <>
                <section
                  className="resource-version-catalog"
                  aria-label="可下载资源版本"
                >
                  <h3>
                    版本与下载{' '}
                    <small>
                      {catalogPhase !== 'complete' ? '当前已加载 ' : ''}
                      {detail.versions.length} 个资源版本 · 按 Minecraft
                      大版本展开
                    </small>
                  </h3>
                  {versionGroups(
                    detail.versions,
                    result?.game ?? gameVersion,
                  ).map(([major, versions]) => (
                    <section className="resource-game-group" key={major}>
                      <button
                        type="button"
                        className="resource-game-group-toggle"
                        aria-expanded={!!openGroups[major]}
                        onClick={() =>
                          setOpenGroups((previous) => ({
                            ...previous,
                            [major]: !previous[major],
                          }))
                        }
                      >
                        Minecraft {major}{' '}
                        <small>{versions.length} 个版本</small>
                        <span>{openGroups[major] ? '收起' : '展开'}</span>
                      </button>
                      {openGroups[major] && (
                        <div className="resource-version-list">
                          {versions.map((version) => (
                            <button
                              type="button"
                              key={version.id}
                              disabled={busy || installing}
                              aria-pressed={versionId === version.id}
                              onClick={() => chooseVersion(version.id)}
                            >
                              <span>
                                <strong>{version.name}</strong>
                                <small>
                                  {version.number} ·{' '}
                                  {version.versionType ?? '类型未提供'} ·{' '}
                                  {version.loaders.join(' / ')}
                                </small>
                              </span>
                              <span>
                                <small>
                                  {displayDate(version.published)} ·{' '}
                                  {displayDownloads(version.downloads)}
                                </small>
                                <small title={version.gameVersions?.join('、')}>
                                  Minecraft{' '}
                                  {version.gameVersions?.join(' / ') ||
                                    result?.game}
                                </small>
                              </span>
                              <span>
                                {versionId === version.id
                                  ? '已选择'
                                  : '选择此版本'}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  ))}
                </section>
                <label className="field-label">
                  兼容版本
                  <select
                    aria-label="在线资源兼容版本"
                    value={versionId}
                    disabled={busy}
                    onChange={(event) => chooseVersion(event.target.value)}
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
                {catalogPhase === 'complete'
                  ? '此项目没有当前资源格式可用的文件，请修改条件后重新搜索。'
                  : '当前游戏版本暂无匹配文件，其他游戏版本列表尚未加载完成。'}
              </p>
            )}
            {['mod', 'resourcepack', 'shader', 'datapack'].includes(kind) &&
            selected ? (
              <>
                <button onClick={() => setTargetOpen(true)}>
                  选择安装位置
                </button>
                {targetOpen && (
                  <Modal
                    title={`安装 ${selected.name}`}
                    onClose={() => setTargetOpen(false)}
                  >
                    <section className="resource-install">
                      {error && <p role="alert">{error}</p>}
                      {message && <p role="status">{message}</p>}
                      <fieldset
                        className="install-target-mode"
                        disabled={busy || installing}
                      >
                        <legend>安装位置</legend>
                        <label>
                          <input
                            type="radio"
                            name="install-mode"
                            checked={!saveOnly}
                            onChange={() => setSaveOnly(false)}
                          />
                          安装到游戏实例
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="install-mode"
                            checked={saveOnly}
                            onChange={() => {
                              setSaveOnly(true);
                              setPlan(null);
                            }}
                          />
                          仅保存到文件夹
                        </label>
                      </fieldset>
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
                      {saveOnly ? (
                        <>
                          <p>
                            仅保存当前版本文件，不安装依赖、不自动启用。数据包仍需自行放入世界的
                            datapacks 目录。
                          </p>
                          <button
                            disabled={
                              busy ||
                              installing ||
                              !file ||
                              source !== 'modrinth'
                            }
                            onClick={() => {
                              setBusy(true);
                              setError('');
                              setMessage('');
                              void service
                                .saveResource(detail.id, versionId, file)
                                .then((saved) => {
                                  if (saved)
                                    setMessage(
                                      '资源已保存到所选文件夹，尚未安装或启用。',
                                    );
                                })
                                .catch((error) =>
                                  setError(
                                    error instanceof Error
                                      ? error.message
                                      : '资源保存失败',
                                  ),
                                )
                                .finally(() => setBusy(false));
                            }}
                          >
                            选择文件夹并保存
                          </button>
                          {source !== 'modrinth' && (
                            <p>当前文件夹保存支持 Modrinth 来源。</p>
                          )}
                        </>
                      ) : (
                        <>
                          {' '}
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
                                setWorldId(
                                  worldSelection?.[event.target.value] ?? '',
                                );
                                setWorlds([]);
                                setPlan(null);
                                setClosed(false);
                              }}
                            >
                              <option value="">请选择实例</option>
                              {native.state?.instances.map((instance) => (
                                <option value={instance.id} key={instance.id}>
                                  {instance.name} · {instance.version} ·{' '}
                                  {instanceLoader(instance)}
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
                                  onWorldSelection?.(
                                    targetId,
                                    event.target.value,
                                  );
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
                            <section
                              className="notice"
                              aria-label="资源安装变更预览"
                            >
                              <h3>
                                将写入 Minecraft {plan.gameVersion} 的文件
                              </h3>
                              {plan.worldId && (
                                <p>
                                  仅安装到世界：{plan.worldId} · 数据包格式{' '}
                                  {plan.dataFormat?.join('.')}
                                </p>
                              )}
                              <ul>
                                {plan.files.map((f) => (
                                  <li key={f.path}>
                                    {f.action === 'keep' ? '保留已有' : '新增'}
                                    ：{f.path} ·{' '}
                                    {(f.size / 1024 / 1024).toFixed(2)} MB
                                  </li>
                                ))}
                              </ul>
                              {plan.warnings.map((warning, index) => (
                                <p key={index}>{warning}</p>
                              ))}
                              {plan.preflight && (
                                <InstallPreflight
                                  report={plan.preflight}
                                  acknowledged={acknowledgeIssues}
                                  onAcknowledge={setAcknowledgeIssues}
                                  disabled={busy || installing}
                                />
                              )}
                              {kind === 'mod' && !plan.preflight && (
                                <p role="alert">
                                  安装预检未完成，请重新生成预览。
                                </p>
                              )}
                              <label className="toggle-row">
                                <span>
                                  我已退出目标实例的游戏并检查以上变更
                                </span>
                                <input
                                  aria-label="确认在线安装前游戏已关闭"
                                  type="checkbox"
                                  disabled={busy || installing}
                                  checked={closed}
                                  onChange={(event) =>
                                    setClosed(event.target.checked)
                                  }
                                />
                              </label>
                              <button
                                disabled={
                                  busy ||
                                  installing ||
                                  !closed ||
                                  (!!plan.preflight?.issues.length &&
                                    !acknowledgeIssues) ||
                                  (kind === 'mod' && !plan.preflight)
                                }
                                onClick={() => void install()}
                              >
                                {plan.preflight?.issues.length
                                  ? '仍然安装'
                                  : '确认安装资源'}
                              </button>
                            </section>
                          )}
                          <p className="hint">
                            {kind === 'mod'
                              ? '安装前会检查模组依赖。'
                              : '安装后需在游戏中启用。'}
                          </p>
                        </>
                      )}
                    </section>
                  </Modal>
                )}
              </>
            ) : (
              <p className="notice">
                {kind === 'modpack'
                  ? '在下方获取选定归档并检查安装变更；整合包始终新建实例。'
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
            {result.query !== query ||
            result.game !== gameVersion ||
            result.category !== category ||
            result.index !== index
              ? ' · 筛选已修改，请重新搜索'
              : ''}
          </p>
          {result.value.hits.length ? (
            result.value.hits.map((hit) => (
              <article className="card resource-hit" key={hit.id}>
                <button
                  type="button"
                  className="resource-row-open"
                  aria-label={`查看 ${hit.title}`}
                  disabled={busy}
                  onClick={() => void open(hit.id)}
                ></button>
                <span className="resource-project-icon">
                  <Package size={32} />
                  {hit.iconUrl && (
                    <img
                      src={hit.iconUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  )}
                </span>
                <div className="resource-hit-info">
                  <h2>{hit.title}</h2>
                  <p title={hit.description}>{hit.description}</p>
                  <div className="resource-hit-metadata">
                    <span>
                      {sourceName} · {hit.author}
                    </span>
                    <span title={hit.gameVersions?.join('、')}>
                      MC {result.game}
                    </span>
                    <span>{displayDownloads(hit.downloads)}</span>
                    <span>更新 {displayDate(hit.updated)}</span>
                  </div>
                </div>
                <div className="resource-hit-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void service
                        .openResource(
                          kind,
                          hit.id,
                          ...(source === 'curseforge'
                            ? ([source] as const)
                            : []),
                        )
                        .catch((error: unknown) =>
                          setError(
                            error instanceof Error
                              ? error.message
                              : '无法打开项目页面',
                          ),
                        )
                    }
                  >
                    {sourceName}
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
                result.game !== gameVersion ||
                result.category !== category ||
                result.index !== index
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
                result.game !== gameVersion ||
                result.category !== category ||
                result.index !== index
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
            {busy
              ? `正在从 ${sourceName} 加载资源列表…`
              : '可搜索部分名称或关键词，也可以留空浏览热门资源。结果与文件信息以来源接口为准。'}
          </p>
        </section>
      )}
      {kind === 'modpack' && (
        <>
          {selected && (
            <label className="field-label">
              整合包归档文件
              <select
                aria-label="在线整合包归档文件"
                disabled={busy || installing}
                value={file}
                onChange={(event) => setFile(event.target.value)}
              >
                {selected.files
                  .filter((file) => /\.(mrpack|zip)$/i.test(file.filename))
                  .map((file) => (
                    <option key={file.filename} value={file.filename}>
                      {file.filename}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <PackInspector
            key={`${detail?.id ?? ''}:${selected?.id ?? ''}:${file}`}
            service={service}
            incomingFile={incomingPack}
            onFileConsumed={onPackConsumed}
            onlineSource={
              detail &&
              selected &&
              selected.files.some(
                (item) =>
                  item.filename === file &&
                  /\.(mrpack|zip)$/i.test(item.filename),
              )
                ? { project: detail.id, version: selected.id, filename: file }
                : undefined
            }
          />
        </>
      )}
    </section>
  );
}
