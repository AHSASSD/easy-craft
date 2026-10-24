import { useState, useSyncExternalStore } from 'react';
import type { NativeService, PackPreview } from '../core/native-contracts';
export function PackInspector({ service }: { service: NativeService }) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const locked = busy || state?.task.status === 'running';
  function show(value: PackPreview | null) {
    setPreview(value);
    setName(
      Array.from(value?.install?.name ?? '')
        .slice(0, 60)
        .join(''),
    );
    setSelected([]);
  }
  async function inspect(file?: File, native = false) {
    if (!file && !native) return;
    setPreview(null);
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (native) {
        show(await service.pickPack());
        return;
      }
      if (!file) return;
      if (!/\.(zip|mrpack)$/i.test(file.name) || file.size > 16 * 1024 * 1024)
        throw new Error('请选择不超过 16 MB 的 ZIP 或 MRPACK 文件');
      show(
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
        if (available && !locked) void inspect(event.dataTransfer.files[0]);
      }}
    >
      <h2>整合包内容预览</h2>
      <p>
        选择或拖入 ZIP / MRPACK，检查内部目录、依赖和下载来源。支持的原版/Fabric
        整合包可以预览变更后新建实例；其他 ZIP 仅检查，不覆盖现有游戏。
      </p>
      <button
        disabled={!available || locked}
        onClick={() => void inspect(undefined, true)}
      >
        从电脑选择 ZIP / MRPACK（最大 512 MiB）
      </button>
      <details>
        <summary>拖放与小文件选择（最大 16 MB）</summary>
        <label>
          选择整合包
          <input
            aria-label="选择整合包"
            type="file"
            accept=".zip,.mrpack"
            disabled={!available || locked}
            onChange={(event) => {
              void inspect(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
      </details>
      {busy && <p role="status">正在检查压缩包目录与清单…</p>}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
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
          {preview.install && (
            <section className="card" aria-label="整合包安装变更预览">
              <h3>安装到全新实例</h3>
              <p>
                Minecraft {preview.install.gameVersion} ·{' '}
                {preview.install.fabricVersion
                  ? `Fabric ${preview.install.fabricVersion}`
                  : '原版'}{' '}
                · 整合包 {preview.install.packVersion}
              </p>
              <label>
                新实例名称
                <input
                  aria-label="整合包新实例名称"
                  value={name}
                  maxLength={120}
                  disabled={locked}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <p>
                {
                  preview.install.files.filter(
                    (file) => !file.optional || selected.includes(file.path),
                  ).length
                }{' '}
                个文件 ·{' '}
                {(
                  preview.install.files
                    .filter(
                      (file) => !file.optional || selected.includes(file.path),
                    )
                    .reduce((size, file) => size + file.size, 0) /
                  1024 /
                  1024
                ).toFixed(1)}{' '}
                MiB（不含游戏基础资源）
              </p>
              {preview.install.files
                .filter((file) => file.optional)
                .map((file) => (
                  <label className="toggle-row" key={file.path}>
                    <span>可选：{file.path}</span>
                    <input
                      type="checkbox"
                      aria-label={`安装可选文件 ${file.path}`}
                      disabled={locked}
                      checked={selected.includes(file.path)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, file.path]
                            : selected.filter((path) => path !== file.path),
                        )
                      }
                    />
                  </label>
                ))}
              <details>
                <summary>全部文件变更</summary>
                <pre className="diagnostics">
                  {preview.install.files
                    .map(
                      (file) =>
                        `${file.optional && !selected.includes(file.path) ? '跳过' : '新增'} ${file.path} · ${file.source}`,
                    )
                    .join('\n')}
                </pre>
              </details>
              <p className="hint">
                下载并校验完成后才加入游戏库。安装过程中不执行包内脚本；首次启动仍需有效的游戏账户与匹配的
                Java。
              </p>
              <button
                className="primary"
                disabled={!available || locked || !name.trim()}
                onClick={() => {
                  const plan = preview.install;
                  if (!plan) return;
                  setBusy(true);
                  setError('');
                  setMessage('');
                  void service
                    .installPack(plan.token, name, selected)
                    .then(() => {
                      setPreview(null);
                      setMessage('整合包安装任务已开始，请查看底部任务状态。');
                    })
                    .catch((error) =>
                      setError(
                        error instanceof Error
                          ? error.message
                          : '整合包安装未开始，请重新检查文件',
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                确认变更并安装整合包
              </button>
            </section>
          )}
        </>
      )}
    </section>
  );
}
