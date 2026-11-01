import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Box,
  Camera,
  FolderOpen,
  Globe2,
  Layers,
  Image,
  Pencil,
  Trash2,
} from 'lucide-react';
import type {
  NativeInstance,
  NativeService,
  NativeSettings,
  WorldEntry,
} from '../core/native-contracts';
import layout from '../plugins/official/layout.json';
import {
  instanceIsolated,
  instanceGameDirectory,
} from '../core/instance-settings';

export function InstanceOverview({
  service,
  instance,
  settings,
  running,
  onWorlds,
  onSettings,
  onRename,
  onRemove,
  report,
}: {
  service: NativeService;
  instance: NativeInstance;
  settings: NativeSettings;
  identity: string;
  running: boolean;
  onWorlds(): void;
  onMods(): void;
  onSettings(): void;
  onChecks(): void;
  onRename?(): void;
  onRemove?(): void;
  report(message: string): void;
}) {
  const [worlds, setWorlds] = useState<WorldEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [folderError, setFolderError] = useState('');
  async function openFolder(
    folder: Parameters<NativeService['openFolder']>[1],
  ) {
    setFolderError('');
    try {
      await service.openFolder(instance.id, folder);
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件夹打开失败';
      setFolderError(message);
      report(message);
    }
  }
  useEffect(() => {
    let disposed = false;
    if (running) return;
    void service
      .worlds(instance.id)
      .then((entries) => {
        if (!disposed) {
          setWorlds(entries);
          setError('');
        }
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : '存档读取失败');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [service, instance.id, running]);
  return (
    <div className="library-details-grid overview-grid overview-dashboard">
      {layout.overview.map((block) => {
        if (block === 'worlds')
          return (
            <section className="card overview-worlds" key={block}>
              <div className="section-heading">
                <h2>本地存档</h2>
                <button className="text-button" onClick={onWorlds}>
                  查看全部 <ArrowUpRight size={14} />
                </button>
              </div>
              {running ? (
                <p className="hint">游戏结束后可查看和管理存档。</p>
              ) : error ? (
                <p className="notice" role="status">
                  {error}
                </p>
              ) : loading ? (
                <p role="status">正在读取存档…</p>
              ) : worlds.length ? (
                <div className="overview-world-list">
                  {worlds.slice(0, 3).map((world) => (
                    <button key={world.id} onClick={onWorlds}>
                      <span className="world-tile">
                        <Globe2 size={24} />
                      </span>
                      <span>
                        <strong title={world.name}>{world.name}</strong>
                        <small>本地存档</small>
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="world-empty">
                  <Globe2 size={24} />
                  <div>
                    <strong>还没有存档</strong>
                    <p>在游戏中创建后会显示在这里。</p>
                  </div>
                </div>
              )}
            </section>
          );
        if (block === 'environment')
          return (
            <section
              className="card library-facts overview-environment"
              key={block}
            >
              <div className="section-heading">
                <h2>运行环境</h2>
                <button className="text-button" onClick={onSettings}>
                  调整设置
                </button>
              </div>
              <dl>
                <dt>Java</dt>
                <dd>
                  Java {instance.javaMajor} ·{' '}
                  {instance.local && !instance.launch?.javaPath
                    ? '自动匹配'
                    : settings.javaPath
                      ? '启动时校验'
                      : '未配置'}
                </dd>
                <dt>内存</dt>
                <dd>
                  {settings.memoryMode === 'auto'
                    ? '自动分配'
                    : `${settings.memoryMb} MB`}
                </dd>
                <dt>游戏目录</dt>
                <dd>
                  {instanceIsolated(instance) ? '版本隔离' : '共享游戏目录'}
                  <small
                    className="instance-storage-path"
                    title={instanceGameDirectory(
                      instance,
                      service.snapshot().state?.dataRoot ?? '',
                    )}
                  >
                    {instanceGameDirectory(
                      instance,
                      service.snapshot().state?.dataRoot ?? '',
                    )}
                  </small>
                </dd>
              </dl>
            </section>
          );
        return (
          <section
            className="card overview-shortcuts"
            key={block}
            aria-label="常用操作"
          >
            <div className="section-heading">
              <h2>常用操作</h2>
              <div className="overview-instance-actions">
                <button disabled={running || !onRename} onClick={onRename}>
                  <Pencil size={14} /> 重命名
                </button>
                <button
                  className="overview-remove"
                  disabled={running || !onRemove}
                  onClick={onRemove}
                >
                  <Trash2 size={14} /> 移除实例
                </button>
              </div>
            </div>
            {!instanceIsolated(instance) && (
              <p className="overview-shared-note">
                共享目录的修改会影响其他使用它的实例。
              </p>
            )}
            <div className="folder-shortcut-grid">
              {(
                [
                  ['game', '游戏文件夹', FolderOpen],
                  ['mods', '模组文件夹', Layers],
                  ['saves', '存档文件夹', Box],
                  ['screenshots', '截图文件夹', Camera],
                  ['resourcepacks', '资源包文件夹', Image],
                  ['shaderpacks', '光影包文件夹', Image],
                ] as const
              ).map(([folder, title, Icon]) => (
                <button
                  key={folder}
                  disabled={running}
                  onClick={() => void openFolder(folder)}
                >
                  <Icon size={16} />
                  <span>{title}</span>
                </button>
              ))}
            </div>
            {running && <p className="hint">游戏或任务结束后可打开文件夹。</p>}
            {folderError && (
              <p className="notice" role="status">
                {folderError}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
