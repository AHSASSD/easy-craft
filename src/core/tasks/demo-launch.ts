import type {
  InstanceService,
  LaunchProgress,
  LaunchService,
} from '../contracts';
function abortError() {
  return new DOMException('演示任务已取消', 'AbortError');
}
export function cancellableDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export function createDemoLaunch(
  instances: InstanceService,
  emit: (progress: LaunchProgress) => void,
  delay = 650,
): LaunchService & { stop(): void; activeCount(): number } {
  const active = new Set<AbortController>();
  let stopped = false;
  const steps: { step: LaunchProgress['step']; message: string }[] = [
    { step: 'validate', message: '检查演示环境（未检测本机 Java）' },
    { step: 'prepare', message: '准备演示资源（未下载文件）' },
    { step: 'arguments', message: '构造演示参数（未生成真实命令）' },
    { step: 'finish', message: '启动完成（模拟，未创建游戏进程）' },
  ];
  return {
    activeCount: () => active.size,
    stop: () => {
      stopped = true;
      active.forEach((controller) => controller.abort());
      active.clear();
    },
    async *simulateLaunch(instanceId, signal) {
      if (stopped) throw new Error('演示启动插件已停止');
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let step: LaunchProgress['step'] = 'validate';
      const progress = (value: LaunchProgress) => {
        if (!stopped) emit(value);
        return value;
      };
      try {
        const instance = await instances.getById(instanceId);
        if (controller.signal.aborted) throw abortError();
        if (!instance) {
          yield progress({
            step,
            status: 'failed',
            message: '演示实例不存在，请重新选择。',
            percent: 0,
          });
          return;
        }
        for (let index = 0; index < steps.length; index++) {
          step = steps[index].step;
          if (controller.signal.aborted) throw abortError();
          yield progress({
            step,
            status: 'running',
            message: steps[index].message,
            percent: index * 25,
          });
          await cancellableDelay(delay, controller.signal);
          if (instance.status !== 'ready') {
            yield progress({
              step,
              status: 'failed',
              message:
                '失败态演示：该实例资料标记为资源缺失或异常。请选择“演示就绪”实例重试；本轮不会修复或下载资源。',
              percent: index * 25,
            });
            return;
          }
          if (step === 'finish') instances.markPlayed(instanceId);
          yield progress({
            step,
            status: 'done',
            message: steps[index].message,
            percent: (index + 1) * 25,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          yield progress({
            step,
            status: 'cancelled',
            message: '模拟启动已取消，没有启动游戏进程。',
          });
          return;
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        active.delete(controller);
      }
    },
  };
}
