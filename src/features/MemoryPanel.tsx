import { useEffect, useState, useSyncExternalStore } from 'react';
import type { MemoryInfo, NativeService } from '../core/native-contracts';
import { useEditor } from './UnsavedChanges';
import { instanceSettings } from '../core/instance-settings';

export function MemoryPanel({
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
  const instance = state?.instances.find((item) => item.id === instanceId);
  const effective = state ? instanceSettings(state.settings, instance) : null;
  const [inherit, setInherit] = useState(!instance?.launch?.memory);
  const [baseMemory, setBaseMemory] = useState(instance?.launch?.memory);
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [mode, setMode] = useState(effective?.memoryMode ?? 'auto');
  const [amount, setAmount] = useState(effective?.memoryMb ?? 2048);
  const [optimize, setOptimize] = useState(effective?.optimizeMemory ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmSystem, setConfirmSystem] = useState(false);
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    const refresh = () => {
      void service
        .memory()
        .then((value) => {
          if (!disposed) setInfo(value);
        })
        .catch(() => {
          if (!disposed) setInfo(null);
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [available, service]);
  const target = mode === 'auto' ? (info?.recommendedMb ?? 2048) : amount;
  const draft = {
    memoryMode: mode,
    memoryMb: amount,
    optimizeMemory: optimize,
  };
  const stored = instanceId ? instance?.launch?.memory : state?.settings;
  const dirty =
    instanceId && inherit
      ? !!stored
      : mode !== stored?.memoryMode ||
        amount !== stored?.memoryMb ||
        optimize !== stored?.optimizeMemory;
  function discard() {
    if (!state) return;
    const current = instanceSettings(state.settings, instance);
    setMode(current.memoryMode);
    setAmount(current.memoryMb);
    setOptimize(current.optimizeMemory);
    setInherit(!instance?.launch?.memory);
    setBaseMemory(instance?.launch?.memory);
  }
  async function save() {
    const current = service.snapshot().state;
    if (!current || current.task.status === 'running')
      throw new Error('请先结束当前任务再保存');
    setBusy(true);
    try {
      if (instanceId) {
        const item = current.instances.find((item) => item.id === instanceId);
        if (!item) throw new Error('实例不存在');
        const memory = inherit ? undefined : draft;
        await service.saveInstanceLaunch(
          instanceId,
          { ...item.launch, memory: baseMemory },
          { ...item.launch, memory },
        );
        setBaseMemory(memory);
      } else
        await service.saveSettings({
          ...current.settings,
          memoryMode: mode,
          memoryMb: amount,
          optimizeMemory: optimize,
        });
      setMessage('内存设置已保存，下次启动生效。');
    } finally {
      setBusy(false);
    }
  }
  useEditor({
    dirty: !!state && dirty,
    save,
    discard,
  });
  return (
    <section className="card" aria-label="游戏内存管理">
      <h2>游戏内存 {!!state && dirty && <small>· 未保存</small>}</h2>
      {instanceId && (
        <p>
          仅此实例。
          {inherit ? '当前继承全局内存配置。' : '当前使用实例内存覆盖。'}
        </p>
      )}
      <p>
        自动模式按当前可用内存分配，并为系统和其他应用留出空间；启动时重新计算。
      </p>
      {!available && <p>内存检测与保存需要桌面版。</p>}
      {info && (
        <>
          <p>
            物理内存 {Math.round((info.totalMb / 1024) * 10) / 10} GB · 当前可用{' '}
            {Math.round((info.availableMb / 1024) * 10) / 10} GB
          </p>
          <meter
            aria-label="系统已使用内存"
            value={info.totalMb - info.availableMb}
            max={info.totalMb}
          />
          <p>
            游戏最大堆内存：{target} MB · 建议预留至少 {info.reserveMb} MB
          </p>
        </>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch((error: unknown) =>
            setMessage(error instanceof Error ? error.message : '保存失败'),
          );
        }}
      >
        <fieldset
          className="native-fieldset"
          disabled={
            !available ||
            !state ||
            busy ||
            state.task.status === 'running' ||
            state.loginPending
          }
        >
          {instanceId && (
            <label>
              <input
                type="checkbox"
                aria-label="继承全局内存"
                checked={inherit}
                onChange={(event) => {
                  setInherit(event.target.checked);
                  if (event.target.checked && state) {
                    setMode(state.settings.memoryMode);
                    setAmount(state.settings.memoryMb);
                    setOptimize(state.settings.optimizeMemory);
                  }
                }}
              />
              继承全局内存（含启动前整理）
            </label>
          )}
          <label>
            内存分配方式
            <select
              aria-label="内存分配方式"
              value={mode}
              disabled={!!instanceId && inherit}
              onChange={(event) =>
                setMode(event.target.value as 'auto' | 'manual')
              }
            >
              <option value="auto">自动分配（推荐）</option>
              <option value="manual">手动分配</option>
            </select>
          </label>
          {mode === 'manual' && (
            <>
              <label>
                最大内存：{amount} MB
                <input
                  aria-label="内存滑块"
                  type="range"
                  min={512}
                  max={16384}
                  step={256}
                  value={amount}
                  disabled={!!instanceId && inherit}
                  onChange={(event) => setAmount(Number(event.target.value))}
                />
              </label>
              <label>
                最大内存（MB）
                <input
                  aria-label="最大内存"
                  type="number"
                  required
                  min={512}
                  max={16384}
                  step={256}
                  value={amount}
                  disabled={!!instanceId && inherit}
                  onChange={(event) => setAmount(Number(event.target.value))}
                />
              </label>
            </>
          )}
          {info && target > info.availableMb - info.reserveMb && (
            <p className="notice">
              当前空闲内存不足以保留建议空间，游戏可能卡顿或启动失败。可关闭其他应用或减少分配。
            </p>
          )}
          <p className="hint">
            这是 Java
            最大堆上限，游戏总占用还包括渲染和原生内存。分配值与下方的工作集整理分别生效。
          </p>
          <button type="submit" className="primary">
            保存内存设置
          </button>
          {instanceId && (
            <button type="button" onClick={discard}>
              放弃内存修改并重新读取
            </button>
          )}
          <label className="toggle-row">
            <span>启动前整理系统工作集（可选）</span>
            <input
              type="checkbox"
              aria-label="启动前内存整理"
              checked={optimize}
              disabled={!!instanceId && inherit}
              onChange={(event) => setOptimize(event.target.checked)}
            />
          </label>
          <p className="hint">
            默认关闭。会尝试整理当前权限可访问进程的工作集，无权限进程自动跳过。不结束程序或清空内核缓存，不保证固定释放量；其他程序可能短暂卡顿，机械硬盘尤其明显。启用后下次启动游戏前执行。
          </p>
          <button
            type="button"
            onClick={() => {
              setBusy(true);
              void service
                .optimizeMemory()
                .then((value) => {
                  setInfo(value);
                  setMessage(
                    '已请求 Windows 整理启动器工作集，当前可用内存已刷新。',
                  );
                })
                .catch((error: unknown) =>
                  setMessage(
                    error instanceof Error ? error.message : '整理失败',
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            仅整理启动器
          </button>
          <button type="button" onClick={() => setConfirmSystem(true)}>
            系统内存整理
          </button>
          {confirmSystem && (
            <div className="notice" role="alert">
              <p>
                系统整理会影响其他可访问进程，可能导致短暂卡顿。只在内存不足时使用。
              </p>
              <button
                type="button"
                onClick={() => {
                  setConfirmSystem(false);
                  setBusy(true);
                  void service
                    .optimizeMemory(true)
                    .then((value) => {
                      setInfo(value);
                      setMessage(
                        '已请求系统整理可访问进程工作集，当前可用内存已刷新。',
                      );
                    })
                    .catch((error: unknown) =>
                      setMessage(
                        error instanceof Error ? error.message : '系统整理失败',
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                确认整理系统工作集
              </button>
              <button type="button" onClick={() => setConfirmSystem(false)}>
                取消系统整理
              </button>
            </div>
          )}
        </fieldset>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
