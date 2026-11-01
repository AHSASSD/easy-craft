import { useState } from 'react';
import type {
  BackupCleanupPlan,
  BackupCleanupReport,
  NativeService,
} from '../core/native-contracts';

export function BackupRetention({
  service,
  id,
  worldId,
  disabled,
  dirty,
  onDone,
}: {
  service: NativeService;
  id: string;
  worldId?: string;
  disabled: boolean;
  dirty: boolean;
  onDone(): Promise<void>;
}) {
  const [keep, setKeep] = useState(10);
  const [plan, setPlan] = useState<BackupCleanupPlan | null>(null);
  const [report, setReport] = useState<BackupCleanupReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy || dirty;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '备份清理失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="backup-retention"
      aria-label={worldId ? '世界配置备份保留管理' : '音画配置备份保留管理'}
    >
      <h4>旧备份保留管理</h4>
      <p className="hint">
        只处理{worldId ? `世界 ${worldId}` : '此实例音画配置'}
        的已校验配置备份，保留最近 N
        份。当前配置、其他世界、缺少归属或含未知内容的备份保留。不会自动清理；本次选择只用于这次确认操作。
      </p>
      <label className="native-label">
        保留最近几份
        <select
          aria-label="配置备份保留数量"
          value={keep}
          disabled={disabled || busy}
          onChange={(event) => {
            setKeep(Number(event.target.value));
            setPlan(null);
            setReport(null);
            setConfirmed(false);
          }}
        >
          {[1, 3, 5, 10, 20, 50, 100].map((number) => (
            <option key={number} value={number}>
              {number} 份
            </option>
          ))}
        </select>
      </label>
      {dirty && <p className="hint">检查前请保存或放弃当前修改。</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <button
        disabled={locked}
        onClick={() =>
          void run(async () => {
            setPlan(null);
            setReport(null);
            setConfirmed(false);
            setPlan(await service.prepareBackupCleanup(id, keep, worldId));
          })
        }
      >
        检查备份保留计划
      </button>
      {busy && <p role="status">正在处理备份，可从底部任务栏取消…</p>}
      {plan && (
        <section
          className="notice backup-preview"
          aria-label="旧配置备份清理预览"
        >
          <h4>
            保留最近 {plan.keep} 份 · 本次可清理 {plan.remove.length} 份
          </h4>
          <p>
            已保护 {plan.retained.length} 份可校验备份。预览有效期 10
            分钟，清单变化须重新检查。清理无法撤销；取消只停止尚未处理的项目。
          </p>
          {plan.warnings.map((warning, index) => (
            <p className="hint" key={index}>
              {warning}
            </p>
          ))}
          <details>
            <summary>查看保留与清理清单</summary>
            <ul className="cache-files">
              {plan.retained.map((entry) => (
                <li key={entry.id}>
                  <span>
                    保留 · {new Date(entry.createdMs).toLocaleString()}
                  </span>
                  <code>{entry.id}</code>
                </li>
              ))}
              {plan.remove.map((entry) => (
                <li key={entry.id}>
                  <span>
                    清理 · {new Date(entry.createdMs).toLocaleString()} ·{' '}
                    {(entry.bytes / 1024).toFixed(1)} KiB
                  </span>
                  <code>{entry.id}</code>
                </li>
              ))}
            </ul>
          </details>
          {!plan.remove.length && <p>没有符合条件的旧备份，未清理任何文件。</p>}
          <label>
            <input
              aria-label="确认旧配置备份清理"
              type="checkbox"
              checked={confirmed}
              disabled={locked || !plan.remove.length}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对清单，同意永久清理所列旧配置备份
          </label>
          <button
            className="primary"
            disabled={locked || !confirmed || !plan.remove.length}
            onClick={() =>
              void run(async () => {
                const result = await service.clearBackupCleanup(plan);
                setReport(result);
                setPlan(null);
                setConfirmed(false);
                await onDone();
              })
            }
          >
            确认清理旧配置备份
          </button>
        </section>
      )}
      {report && (
        <section aria-label="旧配置备份清理结果">
          <p role="status">
            {report.cancelled ? '清理已取消' : '备份处理完成'}：已清理{' '}
            {report.removed.length} 份，保留 {report.kept.length}{' '}
            份候选。最近备份和未列入候选的内容继续保留。
          </p>
          {report.warnings.map((warning, index) => (
            <p className="hint" key={index}>
              {warning}
            </p>
          ))}
          {report.kept.length > 0 && (
            <details>
              <summary>查看未清理原因</summary>
              <ul className="cache-files">
                {report.kept.map((entry) => (
                  <li key={entry.id}>
                    <code>{entry.id}</code>
                    <span>{entry.reason}</span>
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
