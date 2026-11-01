import { useState } from 'react';
import type { NativeState } from '../core/native-contracts';
import { taskAdvice, taskReport } from '../core/task-diagnostics';

export function TaskDiagnostics({ state }: { state: NativeState }) {
  const [feedback, setFeedback] = useState('');
  const [feedbackPreview, setFeedbackPreview] = useState('');
  const preview = taskReport(state);
  return (
    <section className="task-diagnostics" aria-label="任务诊断">
      {state.task.status === 'failed' && (
        <p className="notice">下一步：{taskAdvice(state.task.message)}</p>
      )}
      <h3>诊断摘要</h3>
      <p className="hint">
        摘要仅含当前任务，已隐藏已知身份、令牌和本地路径。分享前请检查日志中是否仍有个人信息。
      </p>
      <textarea aria-label="诊断摘要" readOnly value={preview} rows={6} />
      <button
        type="button"
        onClick={async () => {
          setFeedbackPreview(preview);
          try {
            await navigator.clipboard.writeText(preview);
            setFeedback('诊断摘要已复制');
          } catch {
            setFeedback('无法访问剪贴板，请在上方摘要中全选并复制。');
          }
        }}
      >
        复制诊断摘要
      </button>
      {feedback && feedbackPreview === preview && (
        <p role="status">{feedback}</p>
      )}
    </section>
  );
}
