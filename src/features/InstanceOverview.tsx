import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Box,
  Camera,
  FolderOpen,
  Globe2,
  Layers,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type {
  NativeInstance,
  NativeService,
  NativeSettings,
  WorldEntry,
} from '../core/native-contracts';
import layout from '../plugins/official/layout.json';
import { instanceIsolated } from '../core/instance-settings';

export function InstanceOverview({
  service,
  instance,
  settings,
  identity,
  running,
  onWorlds,
  onMods,
  onSettings,
  onChecks,
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
    <div className="library-details-grid overview-grid">
      {layout.overview.map((block) => {
        if (block === 'worlds')
          return (
            <section className="card overview-worlds" key={block}>
              <div className="section-heading">
                <h2>我的世界</h2>
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
                  <Globe2 size={28} />
                  <div>
                    <strong>第一个世界，从这里开始</strong>
                    <p>进入游戏创建世界后，存档会出现在这里。</p>
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
                  需要 Java {instance.javaMajor} ·{' '}
                  {instance.local && !instance.launch?.javaPath
                    ? '启动时自动匹配本机运行时'
                    : settings.javaPath
                      ? '启动时验证'
                      : '尚未配置'}
                </dd>
                <dt>内存</dt>
                <dd>
                  {settings.memoryMode === 'auto'
                    ? '自动分配'
                    : `${settings.memoryMb} MB`}
                </dd>
                <dt>游戏目录</dt>
                <dd>
                  {instance.local ? '引用原安装 · ' : ''}
                  {instanceIsolated(instance) ? '版本隔离' : '共享目录'}
                </dd>
                <dt>启动身份</dt>
                <dd title={identity}>{identity || '尚未选择账号'}</dd>
              </dl>
              <button className="check-link" onClick={onChecks}>
                <ShieldCheck size={16} /> 查看启动检查
              </button>
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
              <span className="manager-count">
                {instanceIsolated(instance) ? '独立游戏目录' : '共享游戏目录'}
              </span>
            </div>
            {!instanceIsolated(instance) && (
              <p className="hint">
                这些文件夹由多个实例共用，修改内容可能影响其他实例。
              </p>
            )}
            <div className="folder-shortcut-grid">
              {(
                [
                  [
                    'game',
                    '游戏文件夹',
                    '此实例实际使用的游戏文件',
                    FolderOpen,
                  ],
                  ['mods', '模组文件夹', '放入或查看 Mod', Layers],
                  ['saves', '存档文件夹', '查找、备份或迁移世界', Box],
                  [
                    'screenshots',
                    '截图文件夹',
                    '在文件管理器中查看截图',
                    Camera,
                  ],
                ] as const
              ).map(([folder, title, description, Icon]) => (
                <button
                  key={folder}
                  disabled={running}
                  onClick={() => void openFolder(folder)}
                >
                  <Icon size={23} />
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </div>
            <div className="overview-manage-links">
              <span>应用内管理</span>
              <button onClick={onMods}>
                <Layers size={16} />
                管理模组
              </button>
              <button onClick={onWorlds}>
                <Box size={16} />
                管理存档
              </button>
              <button onClick={onSettings}>
                <Settings size={16} />
                实例设置
              </button>
            </div>
            <details
              className="more-folders"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }
              }}
            >
              <summary>更多文件夹</summary>
              <div className="button-row">
                <button
                  disabled={running}
                  onClick={() => void openFolder('resourcepacks')}
                >
                  资源包文件夹
                </button>
                <button
                  disabled={running}
                  onClick={() => void openFolder('shaderpacks')}
                >
                  光影包文件夹
                </button>
              </div>
            </details>
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
