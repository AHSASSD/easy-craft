import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { ModCheck } from '../core/native-contracts';

export function InstallPreflight({
  report,
  acknowledged,
  onAcknowledge,
  disabled = false,
}: {
  report: ModCheck;
  acknowledged: boolean;
  onAcknowledge(value: boolean): void;
  disabled?: boolean;
}) {
  return (
    <section className="mod-install-preflight" aria-label="Mod 安装前预检">
      <h3>
        <ShieldCheck size={17} /> 安装前预检
      </h3>
      <p>已将待安装文件与当前实例一起检查，尚未写入实例。</p>
      {report.issues.length ? (
        <div className="check-issue" role="alert">
          <AlertTriangle size={20} />
          <div>
            <strong>发现 Mod 声明问题</strong>
            <ul>
              {report.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
            <p>你可以取消并调整模组，也可以阅读问题后仍然安装。</p>
          </div>
        </div>
      ) : (
        <p className="hint" role="status">
          已解析的声明中未发现问题；请同时核对下方未确认范围。
        </p>
      )}
      <details>
        <summary>检查范围与未确认项目</summary>
        <ul>
          {report.unchecked.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </details>
      {!!report.issues.length && (
        <label className="toggle-row">
          <span>我已阅读预检问题，仍要安装</span>
          <input
            aria-label="我已阅读预检问题，仍要安装"
            type="checkbox"
            disabled={disabled}
            checked={acknowledged}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
        </label>
      )}
    </section>
  );
}
