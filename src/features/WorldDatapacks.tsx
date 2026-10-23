import { useEffect, useState } from 'react';
import type { ContentEntry, NativeService } from '../core/native-contracts';
export function WorldDatapacks({
  service,
  id,
  worldId,
  running,
  onDownload,
}: {
  service: NativeService;
  id: string;
  worldId: string;
  running: boolean;
  onDownload(): void;
}) {
  const [files, setFiles] = useState<ContentEntry[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (running) return;
    let disposed = false;
    void service
      .datapacks(id, worldId)
      .then((value) => {
        if (!disposed) {
          setFiles(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : '读取数据包失败');
      });
    return () => {
      disposed = true;
    };
  }, [service, id, worldId, running, reload]);
  return (
    <details className="world-datapacks" open>
      <summary>数据包{files ? `（${files.length} 项本地内容）` : ''}</summary>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {!files && !error && (
        <p className="hint">
          {running
            ? '游戏或任务运行中，暂停读取。'
            : '正在读取所选世界的数据包…'}
        </p>
      )}
      {files && (
        <div className="world-datapack-files">
          {files.length ? (
            <ul>
              {files.map((file) => (
                <li key={file.file}>
                  {file.file}
                  <small>
                    {file.version.startsWith('文件夹')
                      ? '文件夹'
                      : `${(file.bytes / 1024 / 1024).toFixed(2)} MB`}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>此世界还没有本地数据包。</p>
          )}
        </div>
      )}
      <div className="content-toolbar">
        <button
          disabled={running}
          onClick={() => setReload((value) => value + 1)}
        >
          刷新数据包列表
        </button>
        <button
          disabled={running}
          onClick={() =>
            void service
              .openDatapacks(id, worldId)
              .catch((error) =>
                setError(
                  error instanceof Error ? error.message : '打开目录失败',
                ),
              )
          }
        >
          打开数据包目录
        </button>
        <button disabled={running} onClick={onDownload}>
          获取世界数据包
        </button>
      </div>
      <p className="hint">
        这里只展示真实目录，文件存在不代表已在世界中启用。游戏中的数据包列表和运行结果另行确认。
      </p>
    </details>
  );
}
