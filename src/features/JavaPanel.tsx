import { useState, useSyncExternalStore } from 'react';
import type { NativeService } from '../core/native-contracts';
import { useEditor } from './UnsavedChanges';
export function JavaPanel({ service }: { service: NativeService }) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const value = draft ?? state?.settings.javaPath ?? '';
  const dirty = draft !== null && value !== state?.settings.javaPath;
  const locked =
    !available ||
    !state ||
    busy ||
    state.task.status === 'running' ||
    state.loginPending;
  async function save() {
    const current = service.snapshot().state;
    if (!current || current.task.status === 'running')
      throw new Error('请先结束当前任务再保存');
    setBusy(true);
    try {
      await service.saveSettings({ ...current.settings, javaPath: value });
      setDraft(null);
      setMessage('Java 设置已保存，下次启动生效。');
    } finally {
      setBusy(false);
    }
  }
  useEditor({ dirty, save, discard: () => setDraft(null) });
  return (
    <section className="card">
      <h2>Java 运行环境 {dirty && <small>· 未保存</small>}</h2>
      <p>全局默认。启动前验证 Java 主版本和 64 位架构。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch((error) => setMessage(String(error)));
        }}
      >
        <fieldset className="native-fieldset" disabled={locked}>
          <label className="native-label">
            Java 可执行文件
            <input
              aria-label="Java 可执行文件"
              value={value}
              required
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              type="button"
              disabled={!value}
              onClick={() => {
                setBusy(true);
                void service
                  .probeJava(value)
                  .then((java) =>
                    setMessage(
                      `Java ${java.major} · ${java.is64Bit ? '64 位' : '32 位'} · 检测成功`,
                    ),
                  )
                  .catch((error) => setMessage(String(error)))
                  .finally(() => setBusy(false));
              }}
            >
              检测 Java
            </button>
            <button type="submit" className="primary">
              保存 Java 设置
            </button>
          </div>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
