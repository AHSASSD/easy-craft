import { useState, useSyncExternalStore, useRef } from 'react';
import type { NativeService } from '../core/native-contracts';
import { useEditor } from './UnsavedChanges';
import { instanceSettings } from '../core/instance-settings';
export function JavaPanel({
  service,
  instanceId,
}: {
  service: NativeService;
  instanceId?: string;
}) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const instance = state?.instances.find((item) => item.id === instanceId);
  const [override, setOverride] = useState<boolean | null>(null);
  const [baseJava, setBaseJava] = useState<string | undefined>();
  const custom = override ?? !!instance?.launch?.javaPath;
  const effective = state ? instanceSettings(state.settings, instance) : null;
  const value =
    instanceId && !custom
      ? (state?.settings.javaPath ?? '')
      : (draft ?? effective?.javaPath ?? '');
  const dirty = instanceId
    ? (custom ? value : undefined) !== instance?.launch?.javaPath
    : draft !== null && value !== state?.settings.javaPath;
  function edit(value: string, custom: boolean) {
    if (draft === null && override === null)
      setBaseJava(instance?.launch?.javaPath);
    setDraft(value);
    setOverride(custom);
  }
  function discard() {
    setDraft(null);
    setOverride(null);
  }
  const locked =
    !available ||
    !state ||
    busy ||
    state.task.status === 'running' ||
    state.loginPending;
  const pending = useRef<Promise<void> | null>(null);
  async function save() {
    if (pending.current) return pending.current;
    const work = persist();
    pending.current = work;
    try {
      await work;
    } finally {
      pending.current = null;
    }
  }
  async function persist() {
    const current = service.snapshot().state;
    if (!current || current.task.status === 'running')
      throw new Error('请先结束当前任务再保存');
    setBusy(true);
    try {
      if (instanceId) {
        const target = current.instances.find((item) => item.id === instanceId);
        if (!target) throw new Error('实例不存在');
        await service.saveInstanceLaunch(
          instanceId,
          {
            ...target.launch,
            javaPath:
              draft === null && override === null
                ? target.launch?.javaPath
                : baseJava,
          },
          {
            ...target.launch,
            javaPath: custom ? value : undefined,
            javaVersion: undefined,
          },
        );
      } else
        await service.saveSettings({ ...current.settings, javaPath: value });
      discard();
      setMessage('Java 设置已保存，下次启动生效。');
    } finally {
      setBusy(false);
    }
  }
  useEditor({ dirty, save, discard, automatic: true });
  async function choose(folder = false) {
    setBusy(true);
    setMessage('');
    try {
      const java =
        folder && instanceId
          ? await service.instanceFolderJava(instanceId)
          : await service.pickJava();
      if (!java) return;
      if (!java.is64Bit || (instance && java.major !== instance.javaMajor))
        throw Error(
          `此实例需要 64 位 Java ${instance?.javaMajor ?? ''}，所选为 Java ${java.major}`,
        );
      const current = service.snapshot().state;
      if (!current) throw Error('本地服务不可用');
      if (instanceId) {
        const target = current.instances.find((v) => v.id === instanceId);
        if (!target) throw Error('实例不存在');
        await service.saveInstanceLaunch(instanceId, target.launch ?? {}, {
          ...target.launch,
          javaPath: java.path,
          javaVersion: java.major,
        });
      } else
        await service.saveSettings({
          ...current.settings,
          javaPath: java.path,
        });
      discard();
      setMessage(`Java ${java.major} · 64 位 · 路径已自动保存`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Java 选择失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card runtime-settings-card">
      <h2>Java 运行环境</h2>
      <p>
        {instanceId
          ? `仅此实例；需要 Java ${instance?.javaMajor ?? '?'}（64 位）。`
          : '全局默认。启动前验证 Java 主版本和 64 位架构。'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch((error) => setMessage(String(error)));
        }}
      >
        <fieldset className="native-fieldset" disabled={locked}>
          {instanceId && (
            <label>
              Java 选择方式
              <select
                aria-label="Java 选择方式"
                value={custom ? 'custom' : 'auto'}
                onChange={(event) => {
                  if (event.target.value === 'folder') {
                    void choose(true);
                    return;
                  }
                  if (event.target.value === 'custom') {
                    edit(value, true);
                    return;
                  }
                  const target = service
                    .snapshot()
                    .state?.instances.find((v) => v.id === instanceId);
                  if (!target) return;
                  setBusy(true);
                  setMessage('');
                  void service
                    .saveInstanceLaunch(instanceId, target.launch ?? {}, {
                      ...target.launch,
                      javaPath: undefined,
                      javaVersion: undefined,
                    })
                    .then(() => {
                      discard();
                      setMessage('已保存：启动时自动匹配兼容 Java');
                    })
                    .catch((error: unknown) => setMessage(String(error)))
                    .finally(() => setBusy(false));
                }}
              >
                <option value="auto">
                  自动选择兼容 Java {instance?.javaMajor}
                </option>
                <option value="custom">使用指定的 Java</option>
                <option value="folder">从版本文件夹选取 Java</option>
              </select>
            </label>
          )}
          {instance && !custom && (
            <p className="hint">
              优先使用本机兼容 Java；缺少时在启动前自动下载官方运行时。
            </p>
          )}
          <label className="native-label">
            {instanceId && !custom ? '全局 Java 候选路径' : 'Java 可执行文件'}
            <input
              aria-label="Java 可执行文件"
              placeholder={
                instanceId && !custom ? '启动时自动匹配或下载' : undefined
              }
              value={value}
              title={value || '尚未指定 Java 路径'}
              required
              disabled={!!instanceId && !custom}
              onChange={(event) =>
                instanceId
                  ? edit(event.target.value, true)
                  : setDraft(event.target.value)
              }
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof HTMLButtonElement ||
                  event.relatedTarget instanceof HTMLSelectElement
                )
                  return;
                if (dirty)
                  void save().catch((error: unknown) =>
                    setMessage(String(error)),
                  );
              }}
            />
          </label>
          {instance?.launch?.javaVersion && (
            <p className="hint">
              已记录 Java {instance.launch.javaVersion} · 64 位
            </p>
          )}
          <div className="button-row">
            <button type="button" onClick={() => void choose()}>
              选择 java.exe
            </button>
          </div>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
