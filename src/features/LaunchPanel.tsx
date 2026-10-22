import type { TaskSnapshot } from '../core/tasks/launch-task';
const steps = [
  { id: 'validate', title: '检查环境' },
  { id: 'prepare', title: '准备资源' },
  { id: 'arguments', title: '构造参数' },
  { id: 'finish', title: '模拟完成' },
];
export function LaunchPanel({
  task,
  cancel,
  retry,
}: {
  task: TaskSnapshot;
  cancel(): void;
  retry(): void;
}) {
  if (task.status === 'idle') return null;
  const labels = {
    running: '模拟启动进行中',
    done: '模拟启动完成',
    failed: '模拟启动失败',
    cancelled: '模拟启动已取消',
  };
  const last = task.logs.at(-1);
  return (
    <section className="card launch-panel" aria-label="模拟启动任务">
      <div className="section-heading">
        <h2>{labels[task.status]}</h2>
        <span className="demo-pill">演示模式</span>
      </div>
      <p>{task.instanceName} · 不下载文件，不运行 Minecraft</p>
      <ol className="launch-steps">
        {steps.map((step) => {
          const progress = task.logs
            .filter((entry) => entry.step === step.id)
            .at(-1);
          return (
            <li key={step.id} data-state={progress?.status ?? 'pending'}>
              <span>
                {progress?.status === 'done' ? '✓' : steps.indexOf(step) + 1}
              </span>
              {step.title}
            </li>
          );
        })}
      </ol>
      <progress
        aria-label="模拟启动进度"
        value={last?.percent ?? 0}
        max={100}
      />
      <div className="task-status" role="status">
        {last?.message ?? '正在准备演示任务…'}
      </div>
      <details>
        <summary>查看演示日志（{task.logs.length}）</summary>
        <ol className="task-logs">
          {task.logs.map((entry, index) => (
            <li key={index}>
              <span>{entry.status}</span>
              {entry.message}
            </li>
          ))}
        </ol>
      </details>
      <div className="button-row">
        {task.status === 'running' ? (
          <button onClick={cancel}>取消模拟启动</button>
        ) : (
          <button onClick={retry}>
            {task.status === 'done' ? '再次体验模拟启动' : '重试模拟启动'}
          </button>
        )}
      </div>
    </section>
  );
}
