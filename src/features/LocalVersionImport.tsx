import { useState, useSyncExternalStore } from 'react';
import { CheckCircle2, FolderSearch, RefreshCw, Search } from 'lucide-react';
import type { LocalVersionScan, NativeService } from '../core/native-contracts';
import minecraftIcon from '../assets/minecraft-official.png';

export function LocalVersionImport({
  service,
  initialScan = null,
  onScan,
}: {
  service: NativeService;
  initialScan?: LocalVersionScan | null;
  onScan?(scan: LocalVersionScan | null): void;
}) {
  const native = useSyncExternalStore(service.subscribe, service.snapshot);
  const [scan, setScan] = useState<LocalVersionScan | null>(initialScan);
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialScan?.candidates.map((v) => [v.id, v.name]) ?? [],
    ),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'reference' | 'copy'>('reference');
  const [message, setMessage] = useState('');
  const locked = busy || native.state?.task.status === 'running';
  const candidates = scan?.candidates ?? [];
  const ready = candidates.filter((v) => v.supported && !v.duplicate);
  const issues = candidates.filter((v) => !v.supported && !v.duplicate);
  const duplicates = candidates.filter((v) => v.duplicate);
  const shown = candidates.filter(
    (v) =>
      (filter === 'all' ||
        (filter === 'ready' && v.supported && !v.duplicate) ||
        (filter === 'issues' && !v.supported && !v.duplicate) ||
        (filter === 'imported' && v.duplicate)) &&
      `${v.name} ${v.gameVersion} ${v.loader}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  );
  async function choose() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const value = await service.scanLocalVersions();
      if (!value) return;
      setScan(value);
      onScan?.(value);
      setSelected([]);
      setMode('reference');
      setFilter('all');
      setQuery('');
      setNames(Object.fromEntries(value.candidates.map((v) => [v.id, v.name])));
    } catch (error) {
      setError(error instanceof Error ? error.message : '扫描失败');
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!scan) return;
    setBusy(true);
    setError('');
    try {
      await service.importLocalVersions(
        scan.token,
        selected.map((id) => ({ id, name: names[id], mode })),
      );
      setScan(null);
      onScan?.(null);
      setSelected([]);
      setMode('reference');
      setMessage('导入任务已提交，进度与取消操作可在底部“任务与日志”查看。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="local-version-import" aria-label="本地版本扫描与导入">
      <div className="scan-location-bar">
        <div className="scan-location">
          <FolderSearch size={20} />
          <div>
            <strong>{scan ? '本地 Minecraft' : '从已有游戏开始'}</strong>
            <span title={scan?.directory}>
              {scan?.directory ?? '选择 .minecraft、versions 或具体版本目录'}
            </span>
          </div>
        </div>
        <button
          disabled={!native.available || locked}
          onClick={() => void choose()}
        >
          <RefreshCw size={14} />
          <span>选择目录并扫描</span>
        </button>
      </div>
      {!scan && !message && (
        <p className="scan-intro">
          只添加一个版本时，可直接选择 versions 下的具体版本文件夹；选择
          .minecraft
          才会扫描整个游戏库。默认直接添加原安装，不复制存档或联网，也可选择独立副本。
        </p>
      )}
      {!native.available && (
        <p className="scan-alert">扫描与本地导入需要桌面版。</p>
      )}
      {busy && !scan && (
        <p role="status" className="scan-intro">
          正在选择目录或检查本地版本，扫描进度及取消可在任务栏查看…
        </p>
      )}
      {native.state?.task.status === 'running' && (
        <div className="scan-current-task" role="status">
          <span>
            {native.state.task.message}
            {native.state.task.total > 0 &&
              ` · ${native.state.task.completed}/${native.state.task.total}`}
          </span>
          <button
            onClick={() =>
              void service
                .cancel()
                .catch((e) =>
                  setError(e instanceof Error ? e.message : '取消失败'),
                )
            }
          >
            取消当前任务
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="scan-alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="scan-success">
          {message}
        </p>
      )}
      {scan && (
        <>
          <div className="scan-summary">
            <div className="scan-summary-title">
              <CheckCircle2 size={16} />
              <strong>扫描完成，尚未导入</strong>
              <span>选择版本后确认导入</span>
            </div>
            <div className="scan-metrics">
              <div>
                <strong>{candidates.length}</strong>
                <span>发现版本</span>
              </div>
              <div className="is-ready">
                <strong>{ready.length}</strong>
                <span>可导入</span>
              </div>
              <div>
                <strong>{issues.length}</strong>
                <span>需处理</span>
              </div>
              <div>
                <strong>{duplicates.length}</strong>
                <span>已导入</span>
              </div>
            </div>
          </div>
          {scan.warnings.length > 0 && (
            <details className="scan-warnings">
              <summary>扫描提示（{scan.warnings.length}）</summary>
              {scan.warnings.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </details>
          )}
          <div className="scan-version-tools">
            <div
              className="scan-filters"
              role="group"
              aria-label="扫描结果筛选"
            >
              {[
                ['all', '全部', candidates.length],
                ['ready', '可导入', ready.length],
                ['issues', '异常', issues.length],
                ['imported', '已导入', duplicates.length],
              ].map(([id, name, count]) => (
                <button
                  key={id}
                  aria-pressed={filter === id}
                  onClick={() => setFilter(String(id))}
                >
                  {name} <span>{count}</span>
                </button>
              ))}
            </div>
            <label className="scan-search">
              <Search size={14} />
              <input
                aria-label="筛选扫描版本"
                placeholder="筛选版本…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="local-version-candidates" aria-label="扫描版本列表">
            {shown.length === 0 && (
              <div className="scan-empty">
                {candidates.length
                  ? '当前条件下没有版本，请调整筛选。'
                  : '没有识别到版本，请选择 Minecraft 根目录或具体版本目录。'}
              </div>
            )}
            {shown.map((v) => (
              <article
                className={`scan-version-row ${selected.includes(v.id) ? 'is-selected' : ''}`}
                key={v.id}
              >
                <div className="scan-version-main">
                  <label className="scan-version-select">
                    <input
                      type="checkbox"
                      aria-label={`导入 ${v.name}`}
                      disabled={locked || !v.supported || v.duplicate}
                      checked={selected.includes(v.id)}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked
                            ? [...old, v.id]
                            : old.filter((id) => id !== v.id),
                        )
                      }
                    />
                    <img src={minecraftIcon} alt="" width={32} height={32} />
                    <span className="scan-version-copy">
                      <strong title={v.name}>{v.name}</strong>
                      <span>
                        {v.gameVersion !== v.name &&
                          v.gameVersion !== '未确认' &&
                          `MC ${v.gameVersion} · `}
                        {v.loader}
                        {v.gameDirectory &&
                          ` · ${v.sourceIsolation ? '独立目录' : '公共目录'}${v.worlds === undefined ? '' : ` · ${v.worlds} 个存档目录`}`}
                      </span>
                    </span>
                  </label>
                  <span
                    className={`scan-state ${v.supported && !v.duplicate ? 'is-ready' : v.duplicate ? '' : 'is-issue'}`}
                  >
                    {v.duplicate
                      ? '已导入'
                      : v.supported
                        ? '可导入'
                        : v.issues.some((s) => /Forge|Quilt|尚不支持/.test(s))
                          ? '暂不支持'
                          : '需要检查'}
                  </span>
                </div>
                {v.issues.length > 0 && (
                  <p className="scan-row-issue" title={v.issues.join('；')}>
                    {v.issues[0]}
                  </p>
                )}
                <details className="scan-version-details">
                  <summary>
                    详情
                    {v.supported && !v.duplicate ? '与导入名称' : '与问题原因'}
                  </summary>
                  <dl>
                    <div>
                      <dt>版本目录</dt>
                      <dd>{v.directory}</dd>
                    </div>
                    {v.gameDirectory && (
                      <div>
                        <dt>游戏内容</dt>
                        <dd>{v.gameDirectory}</dd>
                      </div>
                    )}
                    {v.contentRoots && (
                      <div>
                        <dt>已定位</dt>
                        <dd>
                          {v.contentRoots.join('、') || '未发现常见内容入口'}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {v.gameDirectory && (
                    <p>
                      {v.contentIndexed === false
                        ? mode === 'reference'
                          ? '直接添加不遍历内容，启动时核对必要依赖位置'
                          : '副本模式将在确认导入后检查内容文件数量与大小'
                        : `${v.files} 个内容文件 · ${(v.bytes / 1048576).toFixed(1)} MiB`}
                    </p>
                  )}
                  {v.issues.map((text) => (
                    <p className="scan-alert" key={text}>
                      {text}
                    </p>
                  ))}
                  {v.warnings.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                  {v.supported && !v.duplicate && (
                    <label className="scan-name-label">
                      导入后的实例名称
                      <input
                        aria-label={`实例名称 ${v.name}`}
                        maxLength={60}
                        disabled={locked}
                        value={names[v.id] ?? ''}
                        onChange={(e) =>
                          setNames((old) => ({
                            ...old,
                            [v.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  )}
                </details>
              </article>
            ))}
          </div>
          <div className="local-import-actions">
            <div className="scan-selection">
              <span>
                已选 <strong>{selected.length}</strong> 个版本
              </span>
              <button
                disabled={locked || !ready.length}
                onClick={() => setSelected(ready.slice(0, 32).map((v) => v.id))}
              >
                选择可导入版本（最多 32 个）
              </button>
              <button
                disabled={locked || !selected.length}
                onClick={() => setSelected([])}
              >
                清除选择
              </button>
            </div>
            <details className="scan-copy-details">
              <summary>添加方式与支持范围</summary>
              <div>
                <p>
                  直接添加支持已安装的原版、Fabric、Forge 和
                  NeoForge，保留原目录结构与版本隔离。不会导入账号或第三方启动器私有配置。
                  复制副本目前适用于原版与 Fabric，会检查并复制
                  mods、config、saves、resourcepacks、shaderpacks、screenshots、datapacks、defaultconfigs、kubejs、scripts，以及
                  options.txt、optionsof.txt、optionsshaders.txt、servers.dat 和
                  servers.dat_old。
                </p>
                <p>
                  直接添加只登记启动配置，不受世界目录深度或文件数量限制；启动后游戏会在原目录读写。副本模式每批最多
                  32 个版本，单文件 512 MiB、每个实例内容 2
                  GiB；超出明确报错。失败实例回滚，已完成实例保留。
                </p>
              </div>
            </details>
            <div className="scan-confirm-row">
              <label>
                <span>添加方式</span>
                <select
                  aria-label="本地版本添加方式"
                  disabled={locked}
                  value={mode}
                  onChange={(e) =>
                    setMode(e.target.value as 'reference' | 'copy')
                  }
                >
                  <option value="reference">直接添加已有版本 · 推荐</option>
                  <option value="copy">复制为独立副本</option>
                </select>
              </label>
              <button
                className="primary"
                disabled={
                  locked ||
                  !selected.length ||
                  selected.length > 32 ||
                  selected.some((id) => !names[id]?.trim()) ||
                  (mode === 'copy' &&
                    candidates.some(
                      (v) =>
                        selected.includes(v.id) &&
                        /^(NeoForge|Forge)/.test(v.loader),
                    ))
                }
                onClick={() => void install()}
              >
                导入选中的 {selected.length} 个版本
              </button>
            </div>
            <p className="scan-import-note">
              {mode === 'reference'
                ? '不复制存档、不联网。复用原安装的 Mod、资源和设置；启动后会在原目录正常读写。'
                : '副本模式会遍历与复制游戏内容，并按需联网补齐官方资源。Forge/NeoForge 请使用直接添加。'}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
