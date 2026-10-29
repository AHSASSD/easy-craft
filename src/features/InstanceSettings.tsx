import { useState, useSyncExternalStore } from 'react';
import { Cpu, FolderOpen, SlidersHorizontal } from 'lucide-react';
import type { NativeService } from '../core/native-contracts';
import { instanceIsolated } from '../core/instance-settings';
import { WindowPanel } from './WindowPanel';
import { JavaPanel } from './JavaPanel';
import { MemoryPanel } from './MemoryPanel';
import { IsolationPanel } from './IsolationPanel';
import { WorldSettingsPanel } from './WorldSettingsPanel';
import { useNavigationGuard } from './UnsavedChanges';

const groups = [
  {
    id: 'general',
    name: '显示与音画',
    icon: SlidersHorizontal,
    description: '窗口、声音和画面',
  },
  {
    id: 'runtime',
    name: '运行环境',
    icon: Cpu,
    description: 'Java 与内存分配',
  },
  {
    id: 'directory',
    name: '目录与隔离',
    icon: FolderOpen,
    description: '游戏文件的存放位置',
  },
] as const;
export function InstanceSettings({
  service,
  id,
  running,
}: {
  service: NativeService;
  id: string;
  running: boolean;
}) {
  const { state } = useSyncExternalStore(service.subscribe, service.snapshot);
  const instance = state?.instances.find((item) => item.id === id);
  const [group, setGroup] = useState<(typeof groups)[number]['id']>('general');
  const guard = useNavigationGuard();
  return (
    <div className="workspace-page instance-manager instance-settings-manager">
      <div className="manager-heading">
        <div>
          <h2>实例设置</h2>
          <p>
            {instance?.name ?? '当前实例'} ·
            启动设置单独保存，音画选项随游戏目录生效
          </p>
        </div>
        <span className="scope-badge">
          {instance && instanceIsolated(instance)
            ? '独立游戏目录'
            : '共享游戏目录'}
        </span>
      </div>
      <div className="settings-workspace">
        <nav className="instance-settings-nav" aria-label="实例设置分类">
          {groups.map(({ id: category, name, icon: Icon, description }) => (
            <button
              key={category}
              aria-pressed={group === category}
              className={group === category ? 'selected' : ''}
              onClick={() => guard(() => setGroup(category))}
            >
              <Icon size={17} />
              <span>
                <strong>{name}</strong>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="instance-settings-content">
          <div
            hidden={group !== 'general'}
            className="instance-settings-section"
          >
            <WindowPanel service={service} instanceId={id} />
            <WorldSettingsPanel
              key={`${id}:audio:${instance ? instanceIsolated(instance) : true}`}
              service={service}
              id={id}
              running={running}
              section="options"
            />
          </div>
          <div
            hidden={group !== 'runtime'}
            className="instance-settings-section"
          >
            <JavaPanel service={service} instanceId={id} />
            <MemoryPanel service={service} instanceId={id} />
          </div>
          <div
            hidden={group !== 'directory'}
            className="instance-settings-section"
          >
            <IsolationPanel service={service} instanceId={id} />
          </div>
        </div>
      </div>
    </div>
  );
}
