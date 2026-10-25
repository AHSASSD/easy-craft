import { useEffect, useRef, useState } from 'react';
import type {
  ContentEntry,
  ContentKind,
  NativeService,
} from '../core/native-contracts';
import { Modal } from '../components/Modal';
const titles: Record<ContentKind, string> = {
  mods: '模组',
  resourcepacks: '资源包',
  shaderpacks: '光影包',
  screenshots: '截图',
};
export function ContentPanel({
  service,
  id,
  kind,
  running,
  onDownload,
  query,
  onQuery,
}: {
  service: NativeService;
  id: string;
  kind: ContentKind;
  running: boolean;
  onDownload(): void;
  query: string;
  onQuery(query: string): void;
}) {
  const [entries, setEntries] = useState<ContentEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ file: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (running) return;
    let disposed = false;
    void service
      .content(id, kind)
      .then((value) => {
        if (!disposed) setEntries(value);
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : '读取失败');
      });
    return () => {
      disposed = true;
    };
  }, [service, id, kind, running]);
  async function run(action: () => Promise<unknown>, success = '') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await action();
      setEntries(await service.content(id, kind));
      setMessage(result === false ? '' : success);
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || running || !service.snapshot().available;
  function importFile(file?: File) {
    if (!file) return;
    if (locked || !closed) {
      setError('请先退出游戏并勾选“确认内容修改前游戏已关闭”');
      return;
    }
    void run(
      () => service.importContentFile(id, kind, file),
      '文件已导入；在游戏中是否启用仍需确认。',
    );
  }
  const rows = entries.filter((item) =>
    `${item.name} ${item.file} ${item.version}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div
      className="workspace-page content-manager"
      aria-label="本地内容拖放区"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (kind === 'screenshots') {
          setError('截图目录不支持导入');
          return;
        }
        if (event.dataTransfer.files.length !== 1) {
          setError('请每次拖入一个本地文件');
          return;
        }
        importFile(event.dataTransfer.files[0]);
      }}
    >
      <div className="section-heading">
        <div>
          <h2>
            {titles[kind]} <small>{entries.length}</small>
          </h2>
          <p>读取当前实例的真实本地目录。</p>
        </div>
        <button disabled={locked} onClick={() => void run(async () => {})}>
          重新读取内容
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {running && (
        <p className="notice">
          游戏或任务运行中，文件修改已锁定。退出后可重新读取。
        </p>
      )}
      <div className="content-toolbar">
        <input
          aria-label={`搜索本地${titles[kind]}`}
          placeholder={`搜索${titles[kind]}名称或文件…`}
          maxLength={256}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        <button
          disabled={locked}
          onClick={() => void run(() => service.openContent(id, kind))}
        >
          打开{titles[kind]}目录
        </button>
        {kind !== 'screenshots' && (
          <button onClick={onDownload}>获取{titles[kind]}</button>
        )}
      </div>
      {kind !== 'screenshots' && (
        <>
          <label className="toggle-row">
            <span>我已关闭此实例的游戏，允许修改文件</span>
            <input
              type="checkbox"
              aria-label="确认内容修改前游戏已关闭"
              disabled={locked}
              checked={closed}
              onChange={(event) => setClosed(event.target.checked)}
            />
          </label>
          <button
            disabled={locked || !closed}
            onClick={() =>
              void run(
                () => service.pickContent(id, kind),
                '文件已导入；在游戏中是否启用仍需确认。',
              )
            }
          >
            选择本地{titles[kind]}（最大 512 MiB，不覆盖）
          </button>
          <details>
            <summary>拖放与文件选择（最大 512 MiB）</summary>
            <label className="file-setting">
              导入本地{titles[kind]}（不覆盖现有文件）
              <input
                type="file"
                aria-label={`导入本地${titles[kind]}`}
                accept={kind === 'mods' ? '.jar' : '.zip'}
                disabled={locked || !closed}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  importFile(file);
                }}
              />
            </label>
          </details>
          <p className="hint">
            可向此页拖入单个文件，接收进度与取消在底部任务栏。本地导入会验证压缩路径和格式；未知文件保留。模组启停只识别
            Fabric 模组。外部游戏停留主菜单时无法可靠检测，请先退出。
          </p>
        </>
      )}
      <section className="card">
        {rows.length ? (
          <div className="content-file-list">
            {rows.map((item) => (
              <div key={item.file} className="content-file-row">
                {kind === 'screenshots' &&
                  item.file.toLowerCase().endsWith('.png') &&
                  !running && (
                    <ScreenshotThumbnail
                      key={`${item.file}:${item.revision}`}
                      service={service}
                      id={id}
                      file={item.file}
                    />
                  )}
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.file} · {(item.bytes / 1024 / 1024).toFixed(2)} MB
                  </small>
                  <small>{item.version}</small>
                </div>
                {kind === 'mods' && item.editable && (
                  <label className="toggle-row">
                    <span>{item.enabled ? '已启用' : '已禁用'}</span>
                    <input
                      aria-label={`启用模组 ${item.name}`}
                      type="checkbox"
                      disabled={locked || !closed}
                      checked={item.enabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void run(
                          () =>
                            service.toggleContent(
                              id,
                              item.file,
                              item.revision,
                              enabled,
                            ),
                          '模组状态已更新。',
                        );
                      }}
                    />
                  </label>
                )}
                {kind === 'screenshots' &&
                  item.file.toLowerCase().endsWith('.png') && (
                    <button
                      disabled={locked}
                      onClick={() =>
                        void run(async () =>
                          setPreview({
                            file: item.file,
                            url: await service.contentImage(id, item.file),
                          }),
                        )
                      }
                    >
                      查看截图
                    </button>
                  )}
              </div>
            ))}
          </div>
        ) : (
          <p>
            {entries.length
              ? '没有匹配的内容，清除搜索后重试。'
              : `此实例还没有${titles[kind]}。${kind === 'screenshots' ? '在游戏中截图后可回来查看。' : '可导入本地文件，或前往获取资源。'}`}
          </p>
        )}
      </section>
      {preview && (
        <Modal title={preview.file} onClose={() => setPreview(null)}>
          <img
            className="screenshot-preview"
            src={preview.url}
            alt={preview.file}
          />
        </Modal>
      )}
    </div>
  );
}

function ScreenshotThumbnail({
  service,
  id,
  file,
}: {
  service: NativeService;
  id: string;
  file: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let disposed = false;
    let pending = false;
    let visible = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (!visible) {
          setUrl('');
          return;
        }
        if (pending) return;
        pending = true;
        void service
          .contentImage(id, file)
          .then(async (source) => {
            const bytes = Uint8Array.from(
              atob(source.slice(source.indexOf(',') + 1)),
              (value) => value.charCodeAt(0),
            );
            const bitmap = await createImageBitmap(
              new Blob([bytes], { type: 'image/png' }),
            );
            try {
              if (disposed || !visible) return;
              const canvas = document.createElement('canvas');
              const ratio = Math.min(
                1,
                240 / bitmap.width,
                135 / bitmap.height,
              );
              canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
              canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
              const context = canvas.getContext('2d');
              if (!context) throw new Error('无法生成缩略图');
              context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
              setUrl(canvas.toDataURL('image/png'));
              setError('');
            } finally {
              bitmap.close();
            }
          })
          .catch(() => {
            if (!disposed && visible) setError('缩略图读取失败');
          })
          .finally(() => {
            pending = false;
          });
      },
      { rootMargin: '100px' },
    );
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [service, id, file]);
  return (
    <div className="screenshot-thumbnail" ref={ref}>
      {url ? (
        <img src={url} alt={`${file} 缩略图`} />
      ) : (
        <span>{error || '截图预览'}</span>
      )}
    </div>
  );
}
