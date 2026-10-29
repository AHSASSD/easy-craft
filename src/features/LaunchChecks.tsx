import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import type { ModCheck, NativeService } from '../core/native-contracts';

export function useModCheck(
  service: NativeService,
  id: string | undefined,
  revision: string,
  running: boolean,
  automatic = true,
) {
  const key = `${id ?? ''}:${revision}`;
  type Entry = {
    key: string;
    report?: ModCheck;
    error?: string;
    pending?: boolean;
    stale?: boolean;
  };
  const [result, setResult] = useState<Entry>({ key: '' });
  const [cached, setCached] = useState(new Map<string, Entry>());
  const reports = useRef(new Map<string, Entry>());
  const ticket = useRef(0);
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
    return () => {
      current.current = '';
    };
  }, [key]);
  const read = useCallback(
    async (force = false) => {
      if (
        !id ||
        !service.snapshot().available ||
        running ||
        current.current !== key
      )
        return;
      const request = ++ticket.current;
      const old =
        reports.current.get(key)?.report ?? reports.current.get(id)?.report;
      setResult({ key, report: old, pending: true, stale: !!old });
      try {
        const report = await service.modCheck(id, force);
        if (request !== ticket.current || current.current !== key) return;
        const entry = { key, report };
        reports.current.set(key, entry);
        reports.current.set(id, entry);
        while (reports.current.size > 32)
          reports.current.delete(reports.current.keys().next().value!);
        setCached(new Map(reports.current));
        setResult(entry);
        return report;
      } catch (error) {
        if (request !== ticket.current || current.current !== key) return;
        setResult({
          key,
          report: old,
          stale: !!old,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [id, key, running, service],
  );
  useEffect(() => {
    if (!automatic || running || !id) return;
    let lastRead = 0;
    const check = () => {
      lastRead = Date.now();
      void read();
    };
    const timer = window.setTimeout(check, 220);
    const focus = () => {
      if (
        document.visibilityState !== 'hidden' &&
        Date.now() - lastRead >= 5000
      )
        check();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [automatic, id, read, running]);
  const entry =
    result.key === key
      ? result
      : (cached.get(key) ?? (id ? cached.get(id) : undefined));
  const stale =
    !!entry?.report &&
    (result.key !== key || entry.key !== key || !!entry.stale || running);
  return {
    report: entry?.report,
    error: result.key === key ? result.error : undefined,
    busy: !!(result.key === key && result.pending),
    stale,
    refresh: () => read(true),
    verify: () => read(false),
  };
}

export function LaunchChecks({
  report,
  error,
  busy,
  stale = false,
  canLaunch,
  onRefresh,
  onLaunch,
  onFind,
  onLogs,
}: {
  report?: ModCheck;
  error?: string;
  busy: boolean;
  stale?: boolean;
  canLaunch: boolean;
  onRefresh(): void;
  onLaunch(): void;
  onFind(): void;
  onLogs(): void;
}) {
  return (
    <div className="launch-checks">
      <p className="check-policy">检查结果供你参考，你始终可以选择继续启动。</p>
      <div className="check-launch-action">
        <button className="primary" disabled={!canLaunch} onClick={onLaunch}>
          {busy ? '直接启动' : '仍然启动'}
        </button>
        <button onClick={onRefresh} disabled={busy}>
          <RefreshCw size={15} />
          详细检查
        </button>
      </div>
      {busy && <p role="status">正在读取本地模组声明…</p>}
      {stale && (
        <p className="notice" role="status">
          上次报告已过期或待核对；下列内容仅供参考。
        </p>
      )}
      {error && (
        <p className="notice" role="status">
          检查未完成：{error}。可继续启动或稍后重试。
        </p>
      )}
      {report?.issues.map((issue, index) => (
        <div className="check-issue" key={index}>
          <AlertTriangle size={20} />
          <div>
            <strong>请核对模组声明</strong>
            <p>{issue}</p>
          </div>
        </div>
      ))}
      {report &&
        !report.issues.length &&
        report.details?.complete &&
        !stale && (
          <p className="check-passed">
            <Check size={18} /> 支持范围内未发现声明问题
          </p>
        )}
      {report && (
        <p className="hint">
          {report.details
            ? `${new Date(report.details.checkedAt).toLocaleString()} · ${report.details.complete ? '支持范围检查完成' : '检查未完成'} · ${report.details.scannedFiles} 个归档，重读 ${report.details.parsedFiles}，复用 ${report.details.reusedFiles} · ${report.details.elapsedMs} ms`
            : '此报告未提供完整性信息，请查看检查范围。'}
        </p>
      )}
      {report?.details && <p className="hint">范围：{report.details.scope}</p>}
      {report && (
        <details>
          <summary>检查范围与未检查项目</summary>
          <ul>
            {report.unchecked.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </details>
      )}
      {!report && !error && !busy && <p className="hint">尚未检查此实例。</p>}
      <p className="hint">
        补齐依赖需要先确认兼容版本与来源。目前可前往模组下载选择，升级、降级或禁用现有模组由你单独决定。
      </p>
      <div className="button-row">
        <button onClick={onFind}>查找依赖模组</button>
        <button onClick={onLogs}>查看启动日志</button>
      </div>
      <small>静态检查不能预测所有运行时问题。</small>
    </div>
  );
}
