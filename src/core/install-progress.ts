import type { NativeTask } from './native-contracts';
const names: Record<string, string> = {
  resolve: '解析整合包资源',
  base: '准备 Minecraft 与运行库',
  loader: '安装加载器',
  content: '下载并校验整合包文件',
  files: '写入游戏文件',
  check: '检查文件与模组声明',
  publish: '加入游戏库',
};
function stage(phase: string) {
  if (phase === 'pack-mods') return 'resolve';
  if (phase === 'pack-download') return 'content';
  if (phase === 'pack-files') return 'files';
  if (phase === 'pack-validation') return 'check';
  if (phase === 'pack-publish' || phase === 'pack-committed') return 'publish';
  if (
    phase.includes('fabric') ||
    phase.includes('forge') ||
    phase.includes('processor') ||
    phase.includes('loader')
  )
    return 'loader';
  return 'base';
}
export function installProgress(task: NativeTask) {
  const plan = task.plannedStages?.length
    ? task.plannedStages
    : ['base', 'loader', 'content', 'files', 'check', 'publish'];
  const current = Math.max(0, plan.indexOf(stage(task.phase)));
  let fraction =
    task.total > 0 ? Math.max(0, Math.min(1, task.completed / task.total)) : 0;
  if (task.phase === 'metadata') fraction *= 0.05;
  if (task.phase === 'download') fraction = 0.05 + 0.95 * fraction;
  if (task.phase === 'pack-loader-libraries') fraction = 0.1 + 0.6 * fraction;
  if (task.phase === 'pack-loader-processors') fraction = 0.7 + 0.29 * fraction;
  const rows = plan.map((id, i) => ({
    id,
    name: names[id] ?? id,
    percent:
      task.status === 'succeeded' || i < current
        ? 100
        : i === current
          ? Math.floor(fraction * 100)
          : 0,
    status:
      task.status === 'succeeded' || i < current
        ? '已完成'
        : i > current
          ? '等待中'
          : task.status === 'failed'
            ? '失败'
            : task.status === 'cancelled'
              ? '已取消'
              : '进行中',
  }));
  return {
    rows,
    percent:
      task.status === 'succeeded'
        ? 100
        : Math.min(99, Math.floor(((current + fraction) / plan.length) * 100)),
  };
}
