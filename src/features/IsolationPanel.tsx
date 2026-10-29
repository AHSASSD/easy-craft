import { useState, useSyncExternalStore } from 'react';
import type { NativeService } from '../core/native-contracts';
import { useEditor } from './UnsavedChanges';
import {
  instanceGameDirectory,
  instanceIsolated,
} from '../core/instance-settings';
export function IsolationPanel({
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
  const instance = state?.instances.find((v) => v.id === instanceId);
  const saved = instanceId
    ? instance
      ? instanceIsolated(instance)
      : true
    : (state?.settings.isolateNewInstances ?? true);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [base, setBase] = useState(instance?.launch?.gameIsolation);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const locked =
    !available ||
    !state ||
    busy ||
    state.task.status === 'running' ||
    state.loginPending ||
    (!!instanceId && !instance);
  const root = state?.dataRoot.replace(/\\/g, '/');
  const directory =
    root && instance ? instanceGameDirectory(instance, root, value) : '';
  async function save() {
    const current = service.snapshot().state;
    if (!current || current.task.status === 'running')
      throw new Error('请先结束当前任务');
    setBusy(true);
    try {
      if (instanceId) {
        const target = current.instances.find((v) => v.id === instanceId);
        if (!target) throw new Error('实例不存在');
        await service.saveInstanceLaunch(
          instanceId,
          { ...target.launch, gameIsolation: base },
          { ...target.launch, gameIsolation: value },
        );
      } else
        await service.saveSettings({
          ...current.settings,
          isolateNewInstances: value,
        });
      setDraft(null);
      setMessage(
        instanceId
          ? '游戏目录设置已保存，下次启动生效；原目录内容保留。'
          : '默认隔离设置已保存，只影响以后新安装的游戏版本。',
      );
    } finally {
      setBusy(false);
    }
  }
  useEditor({ dirty, save, discard: () => setDraft(null) });
  return (
    <section
      className="card"
      aria-label={instanceId ? '此版本的目录隔离' : '新版本默认隔离'}
    >
      <h2>版本隔离 {dirty && <small>· 未保存</small>}</h2>
      <p>
        {instanceId
          ? '独立游戏目录分别存放此版本的 Mod、存档与配置；依赖库与资源仍复用公共缓存。'
          : '为新安装的每个版本配置建立独立游戏目录。同一 Minecraft 版本的不同配置也各自独立。现有版本保持原设置，本地与整合包导入默认隔离。'}
      </p>
      <label className="toggle-row">
        <span>{instanceId ? '开启此版本隔离' : '新安装版本默认开启隔离'}</span>
        <input
          aria-label={instanceId ? '此版本隔离' : '默认版本隔离'}
          type="checkbox"
          disabled={locked}
          checked={value}
          onChange={(e) => {
            if (draft === null) setBase(instance?.launch?.gameIsolation);
            setDraft(e.target.checked);
          }}
        />
      </label>
      {directory && (
        <p className="hint">
          {dirty ? '应用后目录' : '游戏目录'}：{directory}
        </p>
      )}
      {instanceId && (
        <p>
          {instance?.local
            ? '此实例直接引用原安装。开启隔离使用原 versions 下的版本文件夹；关闭使用原 Minecraft 根目录。游戏将在所选原目录正常读写。'
            : '关闭隔离后使用 Easy Craft 的共享游戏目录；开启使用该实例独立目录。'}{' '}
          切换不会自动移动、合并或覆盖存档与 Mod。
        </p>
      )}
      <button
        disabled={locked || !dirty}
        onClick={() =>
          void save().catch((error) =>
            setMessage(error instanceof Error ? error.message : '保存失败'),
          )
        }
      >
        保存隔离设置
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
