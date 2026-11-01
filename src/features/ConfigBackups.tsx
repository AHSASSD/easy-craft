import { useState } from 'react';
import { BackupRetention } from './BackupRetention';
import type {
  ConfigBackupList,
  ConfigBackupPreview,
  NativeService,
} from '../core/native-contracts';

export function ConfigBackups({
  service,
  id,
  worldId,
  locked,
  dirty,
  onRestore,
}: {
  service: NativeService;
  id: string;
  worldId?: string;
  locked: boolean;
  dirty: boolean;
  onRestore(preview: ConfigBackupPreview): Promise<void>;
}) {
  const [list, setList] = useState<ConfigBackupList | null>(null);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<ConfigBackupPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '备份操作失败');
    } finally {
      setBusy(false);
    }
  }
  function clearPreview() {
    setPreview(null);
    setConfirmed(false);
  }
  const disabled = locked || busy || !service.snapshot().available;
  const pretty = (value: string) =>
    ({
      true: '开启',
      false: '关闭',
      clear: '晴天',
      rain: '下雨',
      thunder: '雷雨',
    })[value] ?? value;
  return (
    <section
      className="card config-backups"
      aria-label={worldId ? '世界配置备份恢复' : '音画配置备份恢复'}
    >
      <h3>{worldId ? '此世界的配置备份' : '此实例的音画配置备份'}</h3>
      <p>
        先预览具体变更，再确认恢复。恢复前会备份当前文件；只恢复已支持的设置，保留未知字段，不回滚区块或背包。
      </p>
      <p className="hint">
        仅列出带有实例与目标归属记录的备份，预览和恢复时校验内容；早期未记录归属的文件仍保留，不自动匹配。旧备份可在下方检查后明确确认清理，不会自动删除。
      </p>
      <button
        disabled={disabled}
        onClick={() =>
          void run(async () => {
            clearPreview();
            const value = await service.configBackups(id, worldId);
            setList(value);
            setSelected(value.entries[0]?.id ?? '');
          })
        }
      >
        {list ? '刷新配置备份' : '查看配置备份'}
      </button>
      {busy && <p role="status">正在处理配置备份…</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {list?.warnings.map((warning) => (
        <p className="hint" key={warning}>
          {warning}
        </p>
      ))}
      {list &&
        (list.entries.length ? (
          <>
            <label>
              选择备份
              <select
                aria-label={worldId ? '选择世界配置备份' : '选择音画配置备份'}
                value={selected}
                disabled={disabled}
                onChange={(event) => {
                  setSelected(event.target.value);
                  clearPreview();
                }}
              >
                {list.entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new Date(entry.createdMs).toLocaleString()} ·{' '}
                    {(entry.bytes / 1024).toFixed(1)} KiB ·{' '}
                    {entry.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={disabled || !selected}
              onClick={() =>
                void run(async () => {
                  clearPreview();
                  setPreview(
                    await service.previewConfigBackup(id, selected, worldId),
                  );
                })
              }
            >
              预览配置恢复
            </button>
          </>
        ) : (
          <p>此目标还没有可自动恢复的配置备份。保存已有配置后会产生备份。</p>
        ))}
      {preview && (
        <section
          aria-label="配置恢复变更预览"
          className="notice backup-preview"
        >
          <h4>将恢复到{worldId ? `世界 ${worldId}` : '此实例的音画设置'}</h4>
          <p className="hint">
            备份编号：{preview.backup.id} · 共 {preview.changes.length} 项变更
          </p>
          {preview.changes.length ? (
            <div className="backup-changes">
              <table>
                <thead>
                  <tr>
                    <th scope="col">设置</th>
                    <th scope="col">当前</th>
                    <th scope="col">恢复后</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change) => (
                    <tr key={change.key}>
                      <td>{change.key}</td>
                      <td>{pretty(change.before)}</td>
                      <td>{pretty(change.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>支持的配置与当前一致，无需恢复。</p>
          )}
          {dirty && <p>当前有未保存修改，请先保存或放弃，再重新预览恢复。</p>}
          <label>
            <input
              type="checkbox"
              aria-label="确认配置恢复变更"
              checked={confirmed}
              disabled={disabled || dirty}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对变更，并同意先备份当前配置再恢复
          </label>
          <button
            className="primary"
            disabled={
              disabled || dirty || !confirmed || !preview.changes.length
            }
            onClick={() => void run(() => onRestore(preview))}
          >
            确认恢复配置
          </button>
        </section>
      )}
      <BackupRetention
        service={service}
        id={id}
        worldId={worldId}
        disabled={disabled}
        dirty={dirty}
        onDone={async () => {
          clearPreview();
          const value = await service.configBackups(id, worldId);
          setList(value);
          setSelected(value.entries[0]?.id ?? '');
        }}
      />
    </section>
  );
}
