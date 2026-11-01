import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Archive,
  ArrowRight,
  Download,
  FolderOpen,
  LoaderCircle,
  PackageCheck,
} from 'lucide-react';
import type {
  NativeService,
  PackPreview,
  PackInstallPlan,
} from '../core/native-contracts';

export function PackInspector({
  service,
  onlineSource,
  incomingFile,
  onFileConsumed,
  initialPreview,
  onStarted,
}: {
  service: NativeService;
  onlineSource?: PackInstallPlan['origin'];
  incomingFile?: File | null;
  onFileConsumed?(): void;
  initialPreview?: PackPreview;
  onStarted?(): void;
}) {
  const { available, state } = useSyncExternalStore(
    service.subscribe,
    service.snapshot,
  );
  const [preview, setPreview] = useState<PackPreview | null>(
    initialPreview ?? null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(
    Array.from(initialPreview?.install?.name ?? '')
      .slice(0, 60)
      .join(''),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [destination, setDestination] = useState<string | null>(
    initialPreview?.install?.storageRoot ?? null,
  );
  const locked = busy || state?.task.status === 'running';
  const show = useCallback((value: PackPreview) => {
    setPreview(value);
    setName(
      Array.from(value.install?.name ?? '')
        .slice(0, 60)
        .join(''),
    );
    setSelected([]);
    setDestination(value.install?.storageRoot ?? null);
  }, []);
  const inspect = useCallback(
    async (file?: File, native = false, online = false) => {
      if (!file && !native && !online) return;
      setError('');
      setMessage('');
      setBusy(true);
      try {
        let value: PackPreview | null;
        if (online && onlineSource) {
          value = await service.previewOnlinePack(
            onlineSource.project,
            onlineSource.version,
            onlineSource.filename,
          );
        } else if (native) {
          value = await service.pickPack();
        } else {
          if (!file) return;
          if (
            !/\.(zip|mrpack)$/i.test(file.name) ||
            file.size > 512 * 1024 * 1024
          )
            throw new Error('请选择不超过 512 MiB 的 ZIP 或 MRPACK 文件');
          value = await service.previewPackFile(file);
        }
        if (value) show(value);
      } catch (error) {
        setError(error instanceof Error ? error.message : '检查失败');
      } finally {
        setBusy(false);
      }
    },
    [service, onlineSource, show],
  );
  const received = useRef<File | null>(null);
  useEffect(() => {
    if (!incomingFile) {
      received.current = null;
      return;
    }
    if (received.current === incomingFile) return;
    received.current = incomingFile;
    onFileConsumed?.();
    void inspect(incomingFile);
  }, [incomingFile, onFileConsumed, inspect]);
  const plan = preview?.install;
  const files =
    plan?.files.filter(
      (file) => !file.optional || selected.includes(file.path),
    ) ?? [];
  const optional = plan?.files.filter((file) => file.optional) ?? [];
  const platformCount = plan?.curseFiles?.length ?? 0;
  async function chooseDestination(reset = false) {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const value = await service.pickPackDestination(plan.token, reset);
      if (reset || value) setDestination(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : '选择安装位置失败');
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!plan) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await service.installPack(plan.token, name, selected);
      setPreview(null);
      setMessage('整合包安装任务已开始，请查看底部任务状态。');
      onStarted?.();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : '整合包安装未开始，请重新检查文件',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="pack-inspector"
      aria-label="整合包安全检查"
      aria-busy={busy}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer.files.length !== 1) {
          setError('请每次拖入一个 ZIP 或 MRPACK 文件');
          return;
        }
        if (available && !locked) void inspect(event.dataTransfer.files[0]);
      }}
    >
      {!preview && !message && (
        <div className="pack-dropzone">
          <span className="pack-archive-icon">
            <Archive size={30} />
          </span>
          <h3>把整合包带到 Easy Craft</h3>
          <p>
            {onlineSource
              ? onlineSource.filename
              : '拖入 ZIP / MRPACK，或从电脑选择文件'}
          </p>
          {onlineSource ? (
            <button
              className="primary"
              disabled={!available || locked}
              onClick={() => void inspect(undefined, false, true)}
            >
              <Download size={16} /> 下载此版本并检查整合包
            </button>
          ) : (
            <button
              className="primary"
              disabled={!available || locked}
              onClick={() => void inspect(undefined, true)}
              aria-label="从电脑选择 ZIP / MRPACK（最大 512 MiB）"
            >
              <FolderOpen size={16} /> 选择整合包
            </button>
          )}
          <small>单个文件最大 512 MiB · 安装前可查看内容</small>
        </div>
      )}
      {busy && (
        <p className="pack-status" role="status">
          <LoaderCircle size={16} />{' '}
          正在处理整合包，进度与取消可在底部任务中查看…
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="pack-status">
          <PackageCheck size={20} />
          {message}
        </p>
      )}
      {preview && (
        <>
          <div className="pack-summary">
            <span className="pack-archive-icon">
              <Archive size={28} />
            </span>
            <div className="pack-summary-title">
              <small>已读取整合包</small>
              <h3>
                {preview.name} · {preview.kind}
              </h3>
              {plan && (
                <div className="pack-tags">
                  <span>Minecraft {plan.gameVersion}</span>
                  <span>
                    {plan.neoforgeVersion
                      ? 'NeoForge ' + plan.neoforgeVersion
                      : plan.forgeVersion
                        ? 'Forge ' + plan.forgeVersion
                        : plan.fabricVersion
                          ? 'Fabric ' + plan.fabricVersion
                          : '原版'}
                  </span>
                  <span>整合包 {plan.packVersion}</span>
                </div>
              )}
            </div>
            <button
              className="pack-change-file"
              disabled={!available || locked}
              onClick={() => void inspect(undefined, true)}
              aria-label="从电脑选择 ZIP / MRPACK（最大 512 MiB）"
            >
              更换文件
            </button>
          </div>
          <div className="pack-facts">
            <div>
              <small>{platformCount ? '必需在线资源' : '待安装文件'}</small>
              <strong>
                {platformCount || files.length} <span>项</span>
              </strong>
            </div>
            <div>
              <small>{platformCount ? '包内覆盖内容' : '归档展开大小'}</small>
              <strong>
                {(preview.expandedBytes / 1024 / 1024).toFixed(1)}{' '}
                <span>MiB</span>
              </strong>
            </div>
            <div>
              <small>安装方式</small>
              <strong>{plan ? '独立实例' : '仅查看'}</strong>
            </div>
          </div>
          {plan ? (
            <>
              <div
                className="pack-install-form"
                role="region"
                aria-label="整合包安装变更预览"
              >
                <label className="field-label">
                  实例名称
                  <input
                    aria-label="整合包新实例名称"
                    value={name}
                    maxLength={120}
                    disabled={locked}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <div className="pack-destination">
                  <FolderOpen size={17} />
                  <div>
                    <strong>安装位置</strong>
                    <p>
                      {destination ?? state?.dataRoot ?? '当前启动器数据目录'}
                    </p>
                    <small>
                      版本保存到 .minecraft/versions
                      下；共享资源与下载缓存仍保留在启动器数据目录。
                    </small>
                  </div>
                  <button
                    disabled={locked}
                    onClick={() => void chooseDestination()}
                  >
                    更改位置
                  </button>
                  {destination && (
                    <button
                      disabled={locked}
                      onClick={() => void chooseDestination(true)}
                    >
                      恢复默认
                    </button>
                  )}
                </div>
                {plan.recommendedMemoryMb && (
                  <p className="pack-memory">
                    建议内存 {(plan.recommendedMemoryMb / 1024).toFixed(1)}{' '}
                    GiB。
                  </p>
                )}
              </div>
              {optional.length > 0 && (
                <details className="pack-details">
                  <summary>可选内容 · {optional.length} 项</summary>
                  {optional.map((file) => (
                    <label className="toggle-row" key={file.path}>
                      <span>{file.path}</span>
                      <input
                        type="checkbox"
                        aria-label={'安装可选文件 ' + file.path}
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
                </details>
              )}
            </>
          ) : (
            <div className="notice" role="alert">
              {preview.warnings.find((warning) =>
                warning.startsWith('不可安装：'),
              ) ?? '此归档当前仅支持内容预览，尚不能直接创建可启动实例。'}
            </div>
          )}
          {plan && (
            <div className="pack-install-footer">
              <p>安装到独立实例</p>
              <button
                className="primary"
                disabled={
                  !available ||
                  locked ||
                  !name.trim() ||
                  Array.from(name).length > 60
                }
                aria-label="确认变更并安装整合包"
                onClick={() => void install()}
              >
                <Download size={17} /> 开始安装 <ArrowRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
