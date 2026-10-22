import type { GameInstance, LaunchProgress, LaunchService } from '../contracts';
import { validProgress } from '../plugins/kernel';
export type TaskSnapshot = {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
  instanceName: string;
  instanceId: string;
  logs: LaunchProgress[];
};
export function createLaunchTask(service: LaunchService) {
  let snapshot: TaskSnapshot = {
    status: 'idle',
    instanceName: '',
    instanceId: '',
    logs: [],
  };
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let disposed = false;
  const update = (next: TaskSnapshot) => {
    snapshot = next;
    if (!disposed) listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: () => controller?.abort(),
    dispose: () => {
      disposed = true;
      controller?.abort();
      listeners.clear();
    },
    async start(instance: GameInstance) {
      if (disposed || controller) return;
      controller = new AbortController();
      const signal = controller.signal;
      update({
        status: 'running',
        instanceName: instance.name,
        instanceId: instance.id,
        logs: [],
      });
      try {
        for await (const progress of service.simulateLaunch(
          instance.id,
          signal,
        )) {
          if (!validProgress(progress)) throw new Error('启动服务返回无效进度');
          update({ ...snapshot, logs: [...snapshot.logs, progress] });
          if (
            signal.aborted ||
            progress.status === 'failed' ||
            progress.status === 'cancelled'
          )
            break;
        }
        const last = snapshot.logs.at(-1);
        const status =
          signal.aborted || last?.status === 'cancelled'
            ? 'cancelled'
            : last?.status === 'failed'
              ? 'failed'
              : last?.step === 'finish' && last.status === 'done'
                ? 'done'
                : 'failed';
        if (status === 'failed' && last?.status !== 'failed')
          throw new Error('演示任务未正常结束，请重试');
        update({ ...snapshot, status });
      } catch (error) {
        const status = signal.aborted ? 'cancelled' : 'failed';
        update({
          ...snapshot,
          status,
          logs: [
            ...snapshot.logs,
            {
              step: snapshot.logs.at(-1)?.step ?? 'validate',
              status,
              message: signal.aborted
                ? '模拟启动已取消'
                : error instanceof Error
                  ? error.message
                  : '演示启动失败，请重试',
            },
          ],
        });
      } finally {
        controller = undefined;
      }
    },
  };
}
