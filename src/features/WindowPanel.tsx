import { useState, useSyncExternalStore } from 'react';
import type { LaunchOverrides, NativeService } from '../core/native-contracts';
import { useEditor } from './UnsavedChanges';

export function WindowPanel({
  service,
  instanceId,
}: {
  service: NativeService;
  instanceId: string;
}) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const instance = state?.instances.find((v) => v.id === instanceId);
  const [draft, setDraft] = useState<LaunchOverrides['windowMode'] | null>(
    null,
  );
  const [base, setBase] = useState<LaunchOverrides['windowMode']>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const value = draft ?? instance?.launch?.windowMode ?? 'windowed';
  const dirty =
    draft !== null && value !== (instance?.launch?.windowMode ?? 'windowed');
  const locked =
    !available ||
    !instance ||
    busy ||
    state?.task.status === 'running' ||
    state?.loginPending;
  const discard = () => setDraft(null);
  async function save() {
    const current = service
      .snapshot()
      .state?.instances.find((v) => v.id === instanceId);
    if (!current) throw Error('实例不存在');
    setBusy(true);
    try {
      await service.saveInstanceLaunch(
        instanceId,
        { ...current.launch, windowMode: base },
        {
          ...current.launch,
          windowMode: value === 'windowed' ? undefined : value,
        },
      );
      setDraft(null);
      setMessage('启动窗口设置已保存，下次启动生效。');
    } finally {
      setBusy(false);
    }
  }
  useEditor({ dirty, save, discard });
  return (
    <section
      className="card window-settings-card"
      aria-label="此版本的启动窗口"
    >
      <h2>启动窗口 {dirty && <small>· 未保存</small>}</h2>
      <label className="native-label">
        启动显示方式
        <select
          aria-label="启动显示方式"
          value={value}
          disabled={locked}
          onChange={(e) => {
            if (draft === null) setBase(instance?.launch?.windowMode);
            setDraft(e.target.value as LaunchOverrides['windowMode']);
          }}
        >
          <option value="windowed">窗口模式（默认）</option>
          <option value="fullscreen">全屏模式</option>
          <option value="inherit">跟随游戏设置</option>
        </select>
      </label>
      <details className="setting-help">
        <summary>生效方式与配置备份</summary>
        <p className="setting-description">
          默认在创建游戏窗口前关闭全屏，避免加载途中突然切换显示模式。进入游戏后仍可按
          F11 切换。
        </p>
        <p className="hint">
          窗口或全屏模式会更新所选游戏目录 options.txt
          的全屏项，修改前自动备份；跟随游戏设置时保持原文件。
        </p>
      </details>
      <div className="window-setting-actions">
        <button
          disabled={locked || !dirty}
          onClick={() =>
            void save().catch((e) =>
              setMessage(e instanceof Error ? e.message : '保存失败'),
            )
          }
        >
          保存启动窗口设置
        </button>
        {dirty && (
          <button disabled={locked} onClick={discard}>
            放弃窗口修改
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
