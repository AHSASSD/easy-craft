import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Boxes,
  Camera,
  Download,
  FileArchive,
  FolderOpen,
  Image,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  Info,
  Power,
  Trash2,
  FolderSearch,
} from 'lucide-react';
import type {
  ContentEntry,
  ContentKind,
  NativeService,
  ResourcePlan,
  ModDetails,
} from '../core/native-contracts';
import { Modal } from '../components/Modal';
import { InstallPreflight } from './InstallPreflight';
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
  categorySwitch,
}: {
  service: NativeService;
  id: string;
  kind: ContentKind;
  running: boolean;
  onDownload(): void;
  query: string;
  onQuery(query: string): void;
  categorySwitch?: ReactNode;
}) {
  const [entries, setEntries] = useState<ContentEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState(kind === 'screenshots' ? 'reverse' : 'name');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [details, setDetails] = useState<{
    entry: ContentEntry;
    value: ModDetails | null;
  } | null>(null);
  const [removal, setRemoval] = useState<ContentEntry | null>(null);
  const [localPlan, setLocalPlan] = useState<ResourcePlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [preview, setPreview] = useState<{ file: string; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (running) {
      return;
    }
    let disposed = false;
    void service
      .content(id, kind)
      .then((value) => {
        if (!disposed) {
          setEntries(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : '读取失败');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [service, id, kind, running]);
  async function run(
    action: () => Promise<unknown>,
    success: string | ((result: unknown) => string) = '',
    reload = true,
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await action();
      if (reload && service.snapshot().state?.task.status !== 'running')
        setEntries(await service.content(id, kind));
      setMessage(
        result === false
          ? ''
          : typeof success === 'function'
            ? success(result)
            : success,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || running || !service.snapshot().available;
  function importFile(file?: File) {
    if (!file) return;
    if (locked) {
      setError('游戏或任务正在运行，或本地服务暂不可用，请稍后再试');
      return;
    }
    void run(async () => {
      if (kind !== 'mods') return service.importContentFile(id, kind, file);
      setLocalPlan(await service.previewModFile(id, file));
      setAcknowledged(false);
      return false;
    }, '文件已导入；在游戏中是否启用仍需确认。');
  }
  const rows = entries
    .filter(
      (item) =>
        `${item.name} ${item.file} ${item.version}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (statusFilter === 'all' ||
          (statusFilter === 'enabled' && item.editable && item.enabled) ||
          (statusFilter === 'disabled' && item.editable && !item.enabled) ||
          (statusFilter === 'readonly' && !item.editable)),
    )
    .sort((a, b) =>
      sort === 'size'
        ? b.bytes - a.bytes
        : sort === 'reverse'
          ? b.file.localeCompare(a.file)
          : a.name.localeCompare(b.name, 'zh-CN'),
    );
  const Icon =
    kind === 'mods'
      ? Boxes
      : kind === 'screenshots'
        ? Camera
        : kind === 'shaderpacks'
          ? Image
          : FileArchive;
  const instance = service.snapshot().state?.instances.find((v) => v.id === id);
  const size = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const openPreview = (file: string) =>
    void run(async () =>
      setPreview({ file, url: await service.contentImage(id, file) }),
    );
  return (
    <div
      className={`workspace-page content-manager instance-manager ${kind === 'screenshots' ? 'screenshot-manager' : ''}`}
      data-kind={kind}
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
      <div className="manager-heading">
        <div>
          <h2>
            {titles[kind]}{' '}
            <span className="manager-count">
              {loading ? '…' : entries.length}
            </span>
          </h2>
          <p>
            {instance?.name ?? '当前实例'} ·{' '}
            {kind === 'screenshots'
              ? '在这里回看你的冒险瞬间'
              : '管理此实例的本地文件'}
          </p>
        </div>
        <div className="manager-actions">
          <button
            disabled={locked}
            onClick={() => void run(() => service.openContent(id, kind))}
          >
            <FolderOpen size={15} />
            打开目录
          </button>
          <button
            disabled={locked || loading}
            aria-label="重新读取内容"
            title="重新读取内容"
            onClick={() => void run(async () => {})}
          >
            <RefreshCw size={15} />
          </button>
          {kind !== 'screenshots' && (
            <button className="primary" onClick={onDownload}>
              <Download size={15} />
              获取{titles[kind]}
            </button>
          )}
        </div>
      </div>
      {error && !localPlan && !details && !removal && (
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
      <div className="manager-toolbar">
        {categorySwitch}
        <label className="manager-search">
          <Search size={16} />
          <input
            aria-label={`搜索本地${titles[kind]}`}
            placeholder={`搜索${titles[kind]}名称或文件…`}
            maxLength={256}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        {kind === 'mods' && (
          <select
            aria-label="筛选模组状态"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已禁用</option>
            <option value="readonly">只读文件</option>
          </select>
        )}
        <select
          aria-label={`排序${titles[kind]}`}
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="name">名称 A–Z</option>
          <option value="reverse">文件名倒序</option>
          <option value="size">文件大小</option>
        </select>
      </div>
      {kind !== 'screenshots' && (
        <div className="manager-import-bar">
          <button
            disabled={locked}
            aria-label={`选择本地${titles[kind]}（最大 512 MiB，不覆盖）`}
            onClick={() =>
              void run(async () => {
                if (kind !== 'mods') return service.pickContent(id, kind);
                const plan = await service.pickModPlan(id);
                if (plan) {
                  setLocalPlan(plan);
                  setAcknowledged(false);
                }
                return false;
              }, '文件已导入；在游戏中是否启用仍需确认。')
            }
          >
            <Upload size={14} />
            导入文件
          </button>
          <details className="manager-import-help">
            <summary>导入须知</summary>
            <div>
              <label className="file-setting">
                导入本地{titles[kind]}（不覆盖现有文件）
                <input
                  type="file"
                  aria-label={`导入本地${titles[kind]}`}
                  accept={kind === 'mods' ? '.jar' : '.zip'}
                  disabled={locked}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    importFile(file);
                  }}
                />
              </label>
              <p className="hint">
                可向此页拖入单个文件，接收进度与取消在底部任务栏。本地导入会验证压缩路径和格式；未知文件保留。模组启停只识别
                Fabric、Forge 和 NeoForge
                模组。外部游戏停留主菜单时无法可靠检测，请先退出。
              </p>
            </div>
          </details>
        </div>
      )}
      <div className="manager-result-note">
        <span>
          {loading
            ? '正在读取本地目录…'
            : `显示 ${rows.length} / ${entries.length} 项`}
        </span>
        {kind === 'mods' && (
          <span>
            <ShieldCheck size={13} /> 未识别的模组保留为只读
          </span>
        )}
      </div>
      <section
        className={`manager-collection ${kind === 'screenshots' ? 'screenshot-collection' : ''}`}
        aria-label={`${titles[kind]}列表`}
      >
        {running && !entries.length ? (
          <div className="manager-empty">
            <Icon size={30} />
            <h3>运行中暂停读取</h3>
            <p>退出游戏或结束任务后，自动读取本地内容。</p>
          </div>
        ) : loading ? (
          <div className="manager-empty" role="status">
            <RefreshCw size={26} className="loading-spin" />
            <h3>正在读取{titles[kind]}</h3>
            <p>从当前实例获取文件信息</p>
          </div>
        ) : rows.length ? (
          <div
            className={
              kind === 'screenshots' ? 'screenshot-grid' : 'content-file-list'
            }
          >
            {rows.map((item) => (
              <article
                key={item.file}
                className={
                  kind === 'screenshots'
                    ? 'screenshot-card'
                    : 'content-file-row'
                }
              >
                {kind === 'screenshots' &&
                  item.file.toLowerCase().endsWith('.png') &&
                  !running && (
                    <button
                      className="screenshot-open"
                      disabled={locked}
                      aria-label={`查看截图 ${item.file}`}
                      onClick={() => openPreview(item.file)}
                    >
                      <ScreenshotThumbnail
                        key={`${item.file}:${item.revision}`}
                        service={service}
                        id={id}
                        file={item.file}
                      />
                    </button>
                  )}
                {kind !== 'screenshots' && (
                  <span
                    className={`content-kind-icon ${item.editable && !item.enabled ? 'is-disabled' : ''}`}
                  >
                    <Icon size={21} />
                  </span>
                )}
                {kind === 'screenshots' &&
                  (running || !item.file.toLowerCase().endsWith('.png')) && (
                    <div className="screenshot-unavailable">
                      <Camera size={26} />
                      <span>
                        {running ? '运行中暂停预览' : '此格式请在文件夹查看'}
                      </span>
                    </div>
                  )}
                <div className="content-file-info">
                  <div className="content-title-line">
                    <strong title={item.name}>{item.name}</strong>
                    {kind === 'mods' && item.editable && item.version && (
                      <small className="content-version" title={item.version}>
                        {item.version}
                      </small>
                    )}
                  </div>
                  {item.file !== item.name && (
                    <small title={item.file}>{item.file}</small>
                  )}
                </div>
                <span className="content-file-size">{size(item.bytes)}</span>
                {kind === 'mods' && (
                  <div
                    className="mod-row-actions"
                    role="group"
                    aria-label={`${item.name} 快捷操作`}
                  >
                    <span className="mod-row-state">
                      {item.editable
                        ? item.enabled
                          ? '已启用'
                          : '已禁用'
                        : '只读'}
                    </span>
                    <button
                      type="button"
                      aria-pressed={item.enabled && item.editable}
                      aria-label={`${item.enabled ? '禁用' : '启用'}模组 ${item.name}`}
                      title={
                        !item.editable
                          ? '未识别的文件保留为只读'
                          : item.enabled
                            ? '禁用模组'
                            : '启用模组'
                      }
                      disabled={locked || !item.editable}
                      onClick={() =>
                        void run(
                          () =>
                            service.toggleContent(
                              id,
                              item.file,
                              item.revision,
                              !item.enabled,
                            ),
                          '模组状态已更新。',
                        )
                      }
                    >
                      <Power size={15} />
                    </button>
                    <button
                      type="button"
                      className="mod-delete"
                      aria-label={`删除模组 ${item.name}`}
                      title={
                        !item.editable ? '未识别的文件保留为只读' : '删除模组'
                      }
                      disabled={locked || !item.editable}
                      onClick={() => {
                        setError('');
                        setRemoval(item);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={`查看模组详情 ${item.name}`}
                      title="查看详情"
                      disabled={locked}
                      onClick={() => {
                        setDetails({ entry: item, value: null });
                        void run(
                          async () => {
                            const value = await service.modDetails(
                              id,
                              item.file,
                              item.revision,
                            );
                            setDetails((current) =>
                              current?.entry.file === item.file
                                ? { ...current, value }
                                : current,
                            );
                            return false;
                          },
                          '',
                          false,
                        );
                      }}
                    >
                      <Info size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={`打开模组文件位置 ${item.name}`}
                      title="打开文件位置"
                      disabled={locked}
                      onClick={() =>
                        void run(
                          () => service.revealMod(id, item.file, item.revision),
                          '',
                          false,
                        )
                      }
                    >
                      <FolderSearch size={15} />
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="manager-empty">
            <Icon size={30} />
            <h3>
              {error
                ? '暂时无法读取内容'
                : entries.length
                  ? '没有匹配的内容'
                  : `还没有${titles[kind]}`}
            </h3>
            <p>
              {error
                ? '请检查实例目录后重新读取。'
                : entries.length
                  ? '试试其他名称或筛选条件。'
                  : kind === 'screenshots'
                    ? '在游戏中按 F2 截图，回来即可查看。'
                    : '从资源中心获取，或拖入一个本地文件。'}
            </p>
            {!error &&
              (entries.length ? (
                <button
                  onClick={() => {
                    onQuery('');
                    setStatusFilter('all');
                  }}
                >
                  清除筛选
                </button>
              ) : kind !== 'screenshots' ? (
                <button onClick={onDownload}>获取{titles[kind]}</button>
              ) : null)}
          </div>
        )}
      </section>
      {removal && (
        <Modal
          title={`删除模组 · ${removal.name}`}
          onClose={() => setRemoval(null)}
        >
          <p>{removal.file}</p>
          <p>文件将移入此实例的模组回收区，不会永久删除。</p>
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          <div className="mod-dialog-actions">
            <button disabled={busy} onClick={() => setRemoval(null)}>
              取消
            </button>
            <button
              className="mod-delete"
              disabled={locked}
              onClick={() =>
                void run(
                  async () => {
                    const location = await service.removeMod(
                      id,
                      removal.file,
                      removal.revision,
                    );
                    setRemoval(null);
                    return location;
                  },
                  (location) => `模组已删除，回收文件：${String(location)}`,
                )
              }
            >
              确认删除模组
            </button>
          </div>
        </Modal>
      )}
      {details && (
        <Modal
          title={`模组详情 · ${details.entry.name}`}
          onClose={() => setDetails(null)}
        >
          {error ? (
            <p role="alert" className="notice">
              {error}
            </p>
          ) : !details.value ? (
            <p role="status">正在读取本地模组信息…</p>
          ) : (
            <section className="mod-details">
              <dl>
                <dt>版本</dt>
                <dd>{details.value.entry.version || '未提供'}</dd>
                <dt>加载器</dt>
                <dd>{details.value.information?.loader || '未识别'}</dd>
                <dt>模组 ID</dt>
                <dd>{details.value.information?.ids.join('、') || '未提供'}</dd>
                <dt>作者</dt>
                <dd>
                  {details.value.information?.authors.join('、') || '未提供'}
                </dd>
                <dt>许可证</dt>
                <dd>{details.value.information?.license || '未提供'}</dd>
                <dt>文件大小</dt>
                <dd>{size(details.value.entry.bytes)}</dd>
                <dt>文件位置</dt>
                <dd>{details.value.path}</dd>
              </dl>
              {details.value.note && (
                <p className="notice">{details.value.note}</p>
              )}
              {details.value.information?.description && (
                <p className="mod-description">
                  {details.value.information.description}
                </p>
              )}
              {!!details.value.information?.dependencies.length && (
                <details>
                  <summary>
                    声明的依赖 · {details.value.information.dependencies.length}{' '}
                    项
                  </summary>
                  <ul>
                    {details.value.information.dependencies.map(
                      (dependency, index) => (
                        <li key={index}>{dependency}</li>
                      ),
                    )}
                  </ul>
                </details>
              )}
              <button
                disabled={locked}
                onClick={() =>
                  void run(
                    () =>
                      service.revealMod(
                        id,
                        details.entry.file,
                        details.entry.revision,
                      ),
                    '',
                    false,
                  )
                }
              >
                <FolderSearch size={15} /> 打开文件位置
              </button>
            </section>
          )}
        </Modal>
      )}
      {preview && (
        <Modal title={preview.file} onClose={() => setPreview(null)}>
          <img
            className="screenshot-preview"
            src={preview.url}
            alt={preview.file}
          />
        </Modal>
      )}
      {localPlan && (
        <Modal title="本地 Mod 安装预检" onClose={() => setLocalPlan(null)}>
          <p>
            目标实例：
            {service
              .snapshot()
              .state?.instances.find(
                (instance) => instance.id === localPlan.instanceId,
              )?.name ?? localPlan.instanceId}{' '}
            · 来源：本地文件
          </p>
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <ul>
            {localPlan.files.map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
          {localPlan.preflight ? (
            <InstallPreflight
              report={localPlan.preflight}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
              disabled={locked}
            />
          ) : (
            <p role="alert">未取得预检报告，请重新选择文件。</p>
          )}
          <button
            disabled={
              locked ||
              !localPlan.preflight ||
              (!!localPlan.preflight.issues.length && !acknowledged)
            }
            onClick={() =>
              void run(async () => {
                await service.installResources(
                  localPlan.token,
                  !!localPlan.preflight?.issues.length && acknowledged,
                );
                setLocalPlan(null);
              }, '安装任务已开始，可在任务栏查看结果。')
            }
          >
            {localPlan.preflight?.issues.length ? '仍然安装' : '确认安装 Mod'}
          </button>
          <button disabled={busy} onClick={() => setLocalPlan(null)}>
            取消
          </button>
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
