import { useState, useSyncExternalStore } from 'react';
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
  async function save() {
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
          { ...target.launch, javaPath: custom ? value : undefined },
        );
      } else
        await service.saveSettings({ ...current.settings, javaPath: value });
      discard();
      setMessage('Java 设置已保存，下次启动生效。');
    } finally {
      setBusy(false);
    }
  }
  useEditor({ dirty, save, discard });
  return (
    <section className="card">
      <h2>Java 运行环境 {dirty && <small>· 未保存</small>}</h2>
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
              <input
                type="checkbox"
                aria-label={
                  instance?.local ? '自动匹配本机 Java' : '继承全局 Java'
                }
                checked={!custom}
                onChange={(event) => edit(value, !event.target.checked)}
              />
              {instance?.local
                ? '自动匹配本机 Java（优先全局配置）'
                : '继承全局 Java'}
            </label>
          )}
          {instance?.local && !custom && (
            <p>
              全局 Java
              不匹配时，在常见本机运行时目录查找所需版本；可关闭自动匹配，手动指定此实例的
              Java。
            </p>
          )}
          <label className="native-label">
            Java 可执行文件
            <input
              aria-label="Java 可执行文件"
              value={value}
              required
              disabled={!!instanceId && !custom}
              onChange={(event) =>
                instanceId
                  ? edit(event.target.value, true)
                  : setDraft(event.target.value)
              }
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
            {instanceId && (
              <button type="button" onClick={discard}>
                放弃 Java 修改并重新读取
              </button>
            )}
          </div>
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
