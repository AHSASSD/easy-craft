import { useState, useSyncExternalStore } from 'react';
import type { NativeService, PackPreview } from '../core/native-contracts';
export function PackInspector({ service }: { service: NativeService }) {
  const { available } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function inspect(file?: File) {
    if (!file) return;
    setPreview(null);
    setError('');
    setBusy(true);
    try {
      if (!/\.(zip|mrpack)$/i.test(file.name) || file.size > 16 * 1024 * 1024)
        throw new Error('请选择不超过 16 MB 的 ZIP 或 MRPACK 文件');
      setPreview(
        await service.previewPack(
          Array.from(new Uint8Array(await file.arrayBuffer())),
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '检查失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="card"
      aria-label="整合包安全检查"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (available && !busy) void inspect(event.dataTransfer.files[0]);
      }}
    >
      <h2>整合包内容预览</h2>
      <p>
        选择或拖入 ZIP /
        MRPACK，检查内部目录、依赖和下载来源。仅本机读取，当前阶段不安装整合包。
      </p>
      <label>
        选择整合包
        <input
          aria-label="选择整合包"
          type="file"
          accept=".zip,.mrpack"
          disabled={!available || busy}
          onChange={(event) => {
            void inspect(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>
      {busy && <p role="status">正在检查压缩包目录与清单…</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {preview && (
        <>
          <h3>
            {preview.name} · {preview.kind}
          </h3>
          <p>
            {preview.files} 个归档条目 · 展开大小{' '}
            {(preview.expandedBytes / 1024 / 1024).toFixed(1)} MB ·{' '}
            {preview.downloads} 个待下载文件
          </p>
          <ul>
            {preview.dependencies.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <details>
            <summary>内部路径（最多 30 项）</summary>
            <pre className="diagnostics">{preview.paths.join('\n')}</pre>
          </details>
          {preview.warnings.map((warning) => (
            <p key={warning} className="hint">
              {warning}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
