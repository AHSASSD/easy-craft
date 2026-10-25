import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  CacheGroup,
  CachePlan,
  CacheReport,
  CacheSummary,
  NativeService,
} from '../core/native-contracts';

const names: Record<CacheGroup, string> = {
  resources: '资源下载缓存',
  packFiles: '整合包文件缓存',
  packArchives: '在线整合包归档',
  fileInputs: '临时接收文件',
  packInputs: '整合包检查快照',
};
const integrity = {
  verified: '哈希一致',
  corrupt: '哈希不一致',
  temporary: '临时文件',
};
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
export function CachePanel({ service }: { service: NativeService }) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const running = state?.task.status === 'running' || state?.loginPending;
  const [summary, setSummary] = useState<CacheSummary | null>(null);
  const [groups, setGroups] = useState<CacheGroup[]>([
    'resources',
    'packFiles',
    'packArchives',
    'fileInputs',
    'packInputs',
  ]);
  const [plan, setPlan] = useState<CachePlan | null>(null);
  const [report, setReport] = useState<CacheReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!available || running) return;
    let disposed = false;
    void service
      .cacheSummary()
      .then((value) => {
        if (!disposed) setSummary(value);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [available, running, service]);
  const locked = !available || !!running || busy;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '缓存操作失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card cache-manager" aria-label="下载缓存管理">
      <h2>下载缓存管理</h2>
      <p>
        只处理下列下载副本与临时文件。共享游戏资源、已安装模组、存档、账户、皮肤、背景与配置备份均不在清理范围。
      </p>
      <p className="hint">
        清理后，再次安装相关内容可能需要重新下载；已安装游戏继续使用自己的文件。检查和清理期间可从底部任务栏取消，已移除的缓存不会因取消而恢复。
      </p>
      {state && <p className="data-root">数据目录：{state.dataRoot}</p>}
      {!available && <p>缓存检查与清理需要桌面版。</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <button
        disabled={locked}
        onClick={() =>
          void run(async () => {
            setSummary(await service.cacheSummary());
          })
        }
      >
        刷新缓存统计
      </button>
      {summary && (
        <>
          {summary.warnings.map((warning) => (
            <p className="hint" key={warning}>
              {warning}
            </p>
          ))}
          <fieldset className="native-fieldset" disabled={locked}>
            <legend>选择需要检查的缓存</legend>
            {summary.groups.map((row) => (
              <label className="toggle-row" key={row.group}>
                <span>
                  <strong>{names[row.group]}</strong>
                  <small>
                    {row.files} 个可识别文件 · {size(row.bytes)} · {row.skipped}{' '}
                    项未识别内容保留
                    <br />
                    {row.folder}
                  </small>
                </span>
                <input
                  type="checkbox"
                  aria-label={`检查${names[row.group]}`}
                  checked={groups.includes(row.group)}
                  onChange={(event) => {
                    setGroups(
                      event.target.checked
                        ? [...groups, row.group]
                        : groups.filter((item) => item !== row.group),
                    );
                    setPlan(null);
                    setReport(null);
                    setConfirmed(false);
                  }}
                />
              </label>
            ))}
          </fieldset>
        </>
      )}
      <button
        disabled={locked || !groups.length || !summary}
        onClick={() =>
          void run(async () => {
            setPlan(null);
            setReport(null);
            setConfirmed(false);
            setPlan(await service.prepareCache(groups));
          })
        }
      >
        检查缓存并预览清理
      </button>
      {busy && <p role="status">正在处理缓存，可在底部查看任务进度…</p>}
      {plan && (
        <section className="card" aria-label="缓存清理预览">
          <h3>
            将移除 {plan.files.length} 个缓存文件 · {size(plan.bytes)}
          </h3>
          <p className="hint">
            这是文件内容大小，实际腾出的空间取决于是否存在其他共享链接。预览有效期为
            10 分钟，文件变化或占用时保留。
          </p>
          {plan.warnings.map((warning, index) => (
            <p className="hint" key={index}>
              {warning}
            </p>
          ))}
          <details>
            <summary>查看完整文件清单</summary>
            <ul className="cache-files">
              {plan.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>
                  <span>
                    {size(file.bytes)} · {integrity[file.integrity]}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {!plan.files.length && (
            <p>没有可清理的已识别文件；未知或被占用的内容保留。</p>
          )}
          <label className="toggle-row">
            <span>我已核对清单，确认清理这些缓存</span>
            <input
              type="checkbox"
              aria-label="确认缓存清理清单"
              checked={confirmed}
              disabled={locked}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
          </label>
          <button
            className="primary"
            disabled={locked || !confirmed || !plan.files.length}
            onClick={() =>
              void run(async () => {
                const value = await service.clearCache(plan.token);
                setReport(value);
                setPlan(null);
                setConfirmed(false);
                setSummary(await service.cacheSummary());
              })
            }
          >
            确认清理所列缓存
          </button>
        </section>
      )}
      {report && (
        <section className="card" aria-label="缓存清理结果">
          <h3>{report.cancelled ? '清理已取消' : '缓存处理完成'}</h3>
          <p role="status">
            已移除 {report.removedFiles} 个缓存文件（{size(report.removedBytes)}
            ），保留 {report.kept.length} 项。
          </p>
          {report.kept.length > 0 && (
            <details>
              <summary>查看保留原因</summary>
              <ul className="cache-files">
                {report.kept.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>{file.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </section>
  );
}
