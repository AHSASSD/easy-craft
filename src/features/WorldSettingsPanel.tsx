import { useEffect, useState } from 'react';
import {
  Globe2,
  Volume2,
  ShieldCheck,
  RefreshCw,
  Search,
  ChevronRight,
  Languages,
  Upload,
  Download,
} from 'lucide-react';
import { useNavigationGuard } from './UnsavedChanges';
import { useAutoEditor } from './useAutoEditor';
import { WorldDatapacks } from './WorldDatapacks';
import { ConfigBackups } from './ConfigBackups';
import type {
  ClientOptions,
  NativeService,
  WorldEntry,
  WorldSettings,
  ConfigBackupPreview,
  TranslationReport,
} from '../core/native-contracts';

const ruleNames: Record<string, string> = {
  keepInventory: '死亡不掉落',
  doDaylightCycle: '昼夜循环',
  doWeatherCycle: '天气循环',
  doMobSpawning: '自然生成生物',
  mobGriefing: '生物破坏方块',
  doFireTick: '火焰蔓延',
  randomTickSpeed: '随机刻速度',
  spawnRadius: '出生点随机范围',
  doImmediateRespawn: '立即重生',
  naturalRegeneration: '自然恢复生命',
  doInsomnia: '生成幻翼',
  doPatrolSpawning: '生成巡逻队',
  doTraderSpawning: '生成流浪商人',
  doTileDrops: '方块掉落物品',
  doEntityDrops: '实体掉落物品',
  doMobLoot: '生物掉落物品',
  fallDamage: '摔落伤害',
  fireDamage: '火焰伤害',
  drowningDamage: '溺水伤害',
  freezeDamage: '冰冻伤害',
  showDeathMessages: '显示死亡消息',
  reducedDebugInfo: '简化调试信息',
  sendCommandFeedback: '命令反馈',
  commandBlockOutput: '命令方块输出',
  announceAdvancements: '公告进度',
  disableRaids: '禁用袭击',
  playersSleepingPercentage: '跳过夜晚所需睡眠比例',
  maxEntityCramming: '实体挤压上限',
  maxCommandChainLength: '命令链长度上限',
  spawnChunkRadius: '出生区块半径',
  snowAccumulationHeight: '积雪高度上限',
  doWardenSpawning: '生成监守者',
  doLimitedCrafting: '限制配方合成',
  spectatorsGenerateChunks: '旁观者生成区块',
  disableElytraMovementCheck: '禁用鞘翅移动检查',
  globalSoundEvents: '全局声音事件',
  doVinesSpread: '藤蔓蔓延',
  blockExplosionDropDecay: '方块爆炸掉落衰减',
  mobExplosionDropDecay: '生物爆炸掉落衰减',
  tntExplosionDropDecay: 'TNT 爆炸掉落衰减',
  waterSourceConversion: '生成无限水源',
  lavaSourceConversion: '生成无限岩浆源',
  forgiveDeadPlayers: '原谅已死亡玩家',
  universalAnger: '无差别愤怒',
  logAdminCommands: '记录管理命令',
  commandModificationBlockLimit: '命令修改方块数量上限',
  maxCommandForkCount: '命令分支上限',
};
const languages: Record<string, string> = {
  zh_cn: '简体中文',
  zh_tw: '繁體中文（台灣）',
  zh_hk: '繁體中文（香港）',
  en_us: 'English (US)',
  en_gb: 'English (UK)',
  ja_jp: '日本語',
  ko_kr: '한국어',
  de_de: 'Deutsch',
  fr_fr: 'Français',
  es_es: 'Español',
  pt_br: 'Português (Brasil)',
  ru_ru: 'Русский',
  uk_ua: 'Українська',
  it_it: 'Italiano',
};
export function WorldSettingsPanel({
  service,
  id,
  running,
  section = 'all',
  onDatapacks,
}: {
  service: NativeService;
  id: string;
  running: boolean;
  section?: 'all' | 'world' | 'options';
  onDatapacks?(worldId: string): void;
}) {
  const [worlds, setWorlds] = useState<WorldEntry[]>([]);
  const [worldId, setWorldId] = useState('');
  const [world, setWorld] = useState<WorldSettings | null>(null);
  const [options, setOptions] = useState<ClientOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [query, setQuery] = useState('');
  const [worldQuery, setWorldQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoTranslationDraft, setAutoTranslationDraft] = useState<
    boolean | null
  >(null);
  const [worldBase, setWorldBase] = useState('');
  const [optionsBase, setOptionsBase] = useState('');
  const [translation, setTranslation] = useState<TranslationReport | null>(
    null,
  );
  const guard = useNavigationGuard();
  function receiveWorld(value: WorldSettings) {
    setWorld(value);
    setWorldBase(JSON.stringify(value));
  }
  function receiveOptions(value: ClientOptions) {
    setOptions(value);
    setOptionsBase(JSON.stringify(value));
  }
  async function reload() {
    setBusy(true);
    setError('');
    setMessage('');
    setWorld(null);
    setOptions(null);
    try {
      const [entries, opts] = await Promise.all([
        section === 'options'
          ? Promise.resolve([] as WorldEntry[])
          : service.worlds(id),
        section === 'world' ? Promise.resolve(null) : service.options(id),
      ]);
      setWorlds(entries);
      if (opts) receiveOptions(opts);
      const chosen = entries.some((item) => item.id === worldId)
        ? worldId
        : (entries[0]?.id ?? '');
      setWorldId(chosen);
      if (chosen && section !== 'options')
        receiveWorld(await service.world(id, chosen));
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取配置失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    if (running) {
      return;
    }
    void Promise.allSettled([
      section === 'options'
        ? Promise.resolve([] as WorldEntry[])
        : service.worlds(id),
      section === 'world' ? Promise.resolve(null) : service.options(id),
    ])
      .then((results) => {
        if (disposed) return;
        if (results[0].status === 'fulfilled') {
          setWorlds(results[0].value);
          setWorldId(results[0].value[0]?.id ?? '');
        }
        if (results[1].status === 'fulfilled' && results[1].value)
          receiveOptions(results[1].value);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') setError(String(failure.reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [id, service, running, section]);
  useEffect(() => {
    if (!worldId || running || section === 'options') return;
    let disposed = false;
    void service
      .world(id, worldId)
      .then((value) => {
        if (!disposed) receiveWorld(value);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setWorld(null);
          setError(error instanceof Error ? error.message : '读取世界失败');
        }
      });
    return () => {
      disposed = true;
    };
  }, [id, worldId, service, running, section]);
  async function save(kind: 'world' | 'options', propagate = false) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (running || !service.snapshot().available)
        throw new Error('游戏或任务运行中，或本地服务暂不可用，请稍后保存');
      let backup = '';
      if (kind === 'world' && world) {
        backup = await service.saveWorld(id, worldId, world);
        receiveWorld(await service.world(id, worldId));
      }
      if (kind === 'options' && options) {
        backup = await service.saveOptions(id, options);
        receiveOptions(await service.options(id));
      }
      setMessage(
        section === 'options'
          ? '已自动保存'
          : backup
            ? `已保存，原文件已备份：${backup}`
            : '已保存配置。',
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败');
      if (propagate) throw error;
    } finally {
      setBusy(false);
    }
  }
  const dirtyWorld =
    section !== 'options' && !!world && worldBase !== JSON.stringify(world);
  const dirtyOptions =
    section !== 'world' && !!options && optionsBase !== JSON.stringify(options);
  async function restore(preview: ConfigBackupPreview) {
    if (running || !service.snapshot().available || dirtyWorld || dirtyOptions)
      throw new Error('请先关闭游戏并保存或放弃当前修改，再恢复配置');
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const backup = await service.restoreConfigBackup(id, preview);
      await reload();
      setMessage(
        backup
          ? `已恢复所选设置，恢复前的配置已备份：${backup}`
          : '已恢复所选设置；原配置文件不存在，已创建新配置。',
      );
    } finally {
      setBusy(false);
    }
  }
  const auto = useAutoEditor({
    key: JSON.stringify(section === 'options' ? options : [world, options]),
    blocked: busy || running || !service.snapshot().available,
    automatic: section === 'options',
    dirty: dirtyWorld || dirtyOptions,
    save: async () => {
      if (dirtyWorld) await save('world', true);
      if (dirtyOptions) await save('options', true);
    },
    discard: () => {
      if (worldBase) setWorld(JSON.parse(worldBase) as WorldSettings);
      if (optionsBase) setOptions(JSON.parse(optionsBase) as ClientOptions);
    },
  });
  const locked = busy || running || !service.snapshot().available;
  async function importTranslation(file?: File) {
    if (locked) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (file) {
        if (!file.name.toLowerCase().endsWith('.zip'))
          throw Error('请选择资源包 ZIP；模组 JAR 请在模组页安装');
        await service.importContentFile(id, 'resourcepacks', file);
      } else if (!(await service.pickContent(id, 'resourcepacks'))) return;
      setMessage('汉化资源包已导入，请在游戏的“资源包”中启用并调整优先级。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '汉化包导入失败');
    } finally {
      setBusy(false);
    }
  }
  async function installTranslation() {
    if (locked) return;
    setBusy(true);
    setError('');
    setMessage('');
    setTranslation(null);
    try {
      const report = await service.installTranslation(id);
      setTranslation(report);
      receiveOptions(await service.options(id));
      setMessage('汉化资源包已安装并启用，覆盖范围可查看汉化匹配详情。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '自动汉化未完成');
    } finally {
      setBusy(false);
    }
  }
  const worldLoading = !!worldId && !world && !error;
  return (
    <div
      className={`world-settings instance-manager ${section === 'options' ? 'audio-settings-manager' : 'world-manager'}`}
    >
      <div className="manager-heading">
        <div>
          <h2>
            {section === 'options' ? '语言、声音与画面' : '存档'}{' '}
            {section !== 'options' && (
              <span className="manager-count">
                {loading ? '…' : worlds.length}
              </span>
            )}
          </h2>
          <p hidden={section === 'options'}>
            {section === 'options'
              ? '调整这个实例的声音与画面选项'
              : '选择一个世界，管理设置、数据包与配置备份'}
          </p>
        </div>
        <button disabled={locked} onClick={() => guard(() => void reload())}>
          <RefreshCw size={15} />
          重新读取配置
        </button>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {auto.error && (
        <p role="alert">
          {auto.error}{' '}
          <button onClick={() => void auto.retry().catch(() => {})}>
            重试保存
          </button>
        </p>
      )}
      {running && (
        <p className="notice">
          游戏或任务运行中，配置修改已锁定。退出后重新读取再修改。
        </p>
      )}
      {section !== 'options' && (
        <div className="manager-protection-note">
          <ShieldCheck size={18} />
          <div>
            <strong>保存前自动备份</strong>
            <details>
              <summary>了解修改范围</summary>
              <p>
                不修改区块、背包或未知字段。请先退出从其他启动器打开的同一实例；外部游戏停留主菜单时无法可靠检测。
              </p>
            </details>
          </div>
        </div>
      )}
      <div
        className={
          section === 'options' ? 'audio-settings-body' : 'world-manager-body'
        }
      >
        {section !== 'options' && (
          <aside className="world-selector" aria-label="本地存档列表">
            <label className="manager-search">
              <Search size={15} />
              <input
                aria-label="搜索本地存档"
                placeholder="搜索存档…"
                value={worldQuery}
                onChange={(e) => setWorldQuery(e.target.value)}
              />
            </label>
            <div className="world-choice-list">
              {loading ? (
                <p role="status">正在读取存档…</p>
              ) : (
                worlds
                  .filter((item) =>
                    item.name.toLowerCase().includes(worldQuery.toLowerCase()),
                  )
                  .map((item) => (
                    <button
                      key={item.id}
                      className={item.id === worldId ? 'selected' : ''}
                      aria-pressed={item.id === worldId}
                      title={item.name}
                      onClick={() =>
                        guard(() => {
                          setWorld(null);
                          setError('');
                          setWorldId(item.id);
                        })
                      }
                    >
                      <Globe2 size={18} />
                      <span>
                        <strong>{item.name}</strong>
                        <small title={`saves/${item.id}`}>
                          saves/{item.id}
                        </small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))
              )}
              {!loading && !worlds.length && (
                <p className="hint">还没有本地存档</p>
              )}
              {!!worlds.length &&
                !worlds.some((item) =>
                  item.name.toLowerCase().includes(worldQuery.toLowerCase()),
                ) && <p className="hint">没有匹配的存档</p>}
            </div>
          </aside>
        )}
        <div className="world-detail-pane">
          {section !== 'world' && (
            <section
              className="card language-settings"
              aria-label="游戏语言与汉化"
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const files = event.dataTransfer.files;
                if (files.length !== 1) {
                  setError('请一次拖入一个汉化资源包 ZIP');
                  return;
                }
                const file = files[0];
                guard(() => void importTranslation(file));
              }}
            >
              <h3>
                <Languages size={18} />
                语言与汉化
              </h3>
              <label>
                游戏语言
                <select
                  aria-label="游戏语言"
                  value={options?.language.toLowerCase() ?? 'zh_cn'}
                  disabled={locked || !options}
                  onChange={(event) =>
                    options &&
                    setOptions({ ...options, language: event.target.value })
                  }
                >
                  {options && !languages[options.language.toLowerCase()] && (
                    <option value={options.language.toLowerCase()}>
                      {options.language}
                    </option>
                  )}
                  {Object.entries(languages).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="language-actions">
                <button
                  className="primary"
                  disabled={locked}
                  onClick={() => guard(() => void installTranslation())}
                >
                  <Download size={15} />
                  自动安装汉化
                </button>
                <button
                  disabled={locked}
                  onClick={() => guard(() => void importTranslation())}
                >
                  <Upload size={15} />
                  导入汉化资源包
                </button>
                <label className="visually-hidden">
                  选择 ZIP
                  <input
                    type="file"
                    accept=".zip"
                    aria-label="导入本地汉化资源包"
                    disabled={locked}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) guard(() => void importTranslation(file));
                    }}
                  />
                </label>
              </div>
              <label className="toggle-row">
                <span>新整合包缺少汉化时自动补充</span>
                <input
                  type="checkbox"
                  aria-label="缺少汉化时自动补充"
                  disabled={locked}
                  checked={
                    (autoTranslationDraft ??
                      service.snapshot().state?.settings.autoTranslatePacks) !==
                    false
                  }
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    guard(() => {
                      setAutoTranslationDraft(enabled);
                      setBusy(true);
                      setError('');
                      const target = service.snapshot().state?.settings;
                      if (!target) {
                        setBusy(false);
                        return;
                      }
                      void service
                        .saveSettings({
                          ...target,
                          autoTranslatePacks: enabled,
                        })
                        .catch((error: unknown) =>
                          setError(
                            error instanceof Error
                              ? error.message
                              : '保存自动汉化设置失败',
                          ),
                        )
                        .finally(() => {
                          setBusy(false);
                          setAutoTranslationDraft(null);
                        });
                    });
                  }}
                />
              </label>
              <p className="hint">
                为当前版本和已启用模组匹配 CFPA
                汉化；不包含任务书、脚本等专用补丁。
              </p>
              {translation && (
                <details>
                  <summary>汉化匹配详情</summary>
                  <p>
                    {translation.source} · {translation.file}
                  </p>
                  <p>匹配：{translation.matched.join('、')}</p>
                  {!!translation.unmatched.length && (
                    <p>CFPA 未匹配：{translation.unmatched.join('、')}</p>
                  )}
                  {!!translation.skippedFiles && (
                    <p>{translation.skippedFiles} 个模组文件未能识别。</p>
                  )}
                  <p className="hint">
                    匹配依据是资源命名空间，不能保证所有词条均有翻译。未匹配的模组可能已自带中文。已保留玩家原有资源包及其优先级。
                  </p>
                </details>
              )}
            </section>
          )}
          <div className="world-columns">
            {section !== 'options' && (
              <section className="card world-detail-card">
                <h3>
                  <Globe2 size={18} />
                  {worlds.find((item) => item.id === worldId)?.name ??
                    '世界配置'}
                </h3>
                <label className="visually-hidden">
                  选择存档
                  <select
                    aria-label="选择存档"
                    disabled={locked || !worlds.length}
                    value={worldId}
                    onChange={(event) => {
                      const next = event.target.value;
                      guard(() => {
                        setWorld(null);
                        setError('');
                        setWorldId(next);
                      });
                    }}
                  >
                    {worlds.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {worldLoading && (
                  <p role="status" className="hint">
                    正在读取所选世界…
                  </p>
                )}
                {!loading && !running && !worlds.length && (
                  <p className="hint">
                    此实例尚无可读取的存档。先在 Minecraft
                    中创建世界，再回来调整；不会自动创建空存档。
                  </p>
                )}
                {world && (
                  <div className="world-summary-tags">
                    <span>
                      {world.hardcore
                        ? '极限模式'
                        : (['生存', '创造', '冒险', '旁观者'][
                            world.gameMode ?? -1
                          ] ?? '自定义模式')}
                    </span>
                    <span>
                      {['和平', '简单', '普通', '困难'][world.difficulty]}难度
                    </span>
                    <span>{world.gameRules.length} 项规则</span>
                  </div>
                )}
                {worldId && onDatapacks && (
                  <WorldDatapacks
                    key={worldId}
                    service={service}
                    id={id}
                    worldId={worldId}
                    running={running || busy}
                    onDownload={() => onDatapacks(worldId)}
                  />
                )}
                {world && (
                  <fieldset
                    className="native-fieldset world-basic-fields"
                    disabled={locked || world.hardcore}
                  >
                    {world.hardcore && (
                      <p className="notice">
                        极限模式存档仅供查看，避免破坏其规则。
                      </p>
                    )}
                    <label>
                      难度
                      <select
                        aria-label="世界难度"
                        value={world.difficulty}
                        disabled={world.difficultyLocked}
                        onChange={(event) =>
                          setWorld({
                            ...world,
                            difficulty: Number(event.target.value),
                          })
                        }
                      >
                        {['和平', '简单', '普通', '困难'].map(
                          (value, index) => (
                            <option key={value} value={index}>
                              {value}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="toggle-row">
                      <span>锁定难度</span>
                      <input
                        aria-label="锁定难度"
                        type="checkbox"
                        checked={world.difficultyLocked}
                        onChange={(event) =>
                          setWorld({
                            ...world,
                            difficultyLocked: event.target.checked,
                          })
                        }
                      />
                    </label>
                    {world.gameMode !== null && (
                      <label>
                        默认游戏模式
                        <select
                          aria-label="默认游戏模式"
                          value={world.gameMode}
                          onChange={(event) =>
                            setWorld({
                              ...world,
                              gameMode: Number(event.target.value),
                            })
                          }
                        >
                          {['生存', '创造', '冒险', '旁观者'].map(
                            (value, index) => (
                              <option key={value} value={index}>
                                {value}
                              </option>
                            ),
                          )}
                        </select>
                        <small>
                          只修改世界默认模式，不覆盖已有玩家的独立模式。
                        </small>
                      </label>
                    )}
                    {world.allowCommands !== null && (
                      <label className="toggle-row">
                        <span>允许作弊命令</span>
                        <input
                          aria-label="允许作弊命令"
                          type="checkbox"
                          checked={world.allowCommands}
                          onChange={(event) =>
                            setWorld({
                              ...world,
                              allowCommands: event.target.checked,
                            })
                          }
                        />
                      </label>
                    )}
                    {world.dayTime !== null && (
                      <label>
                        世界时间（刻数）
                        <input
                          aria-label="世界时间"
                          value={world.dayTime}
                          inputMode="numeric"
                          pattern="[0-9]{1,19}"
                          onChange={(event) =>
                            setWorld({ ...world, dayTime: event.target.value })
                          }
                        />
                        <small>24000 刻为一天；不修改世界总运行年龄。</small>
                      </label>
                    )}
                    {world.weather !== null && (
                      <label>
                        天气
                        <select
                          aria-label="世界天气"
                          value={world.weather}
                          onChange={(event) =>
                            setWorld({
                              ...world,
                              weather: event.target
                                .value as WorldSettings['weather'],
                            })
                          }
                        >
                          <option value="clear">晴朗</option>
                          <option value="rain">下雨</option>
                          <option value="thunder">雷雨</option>
                        </select>
                        <small>
                          切换天气时设置约 10 分钟计时，后续由天气循环规则控制。
                        </small>
                      </label>
                    )}
                    <button
                      className="primary"
                      disabled={locked}
                      onClick={() => void save('world')}
                    >
                      保存世界设置
                    </button>
                  </fieldset>
                )}
              </section>
            )}
            {section !== 'world' && (
              <section className="card">
                <h3>
                  <Volume2 size={18} />
                  游戏音画选项
                </h3>
                <p className="hint">
                  来自此实例的 options.txt，对整个实例生效，和所选世界独立保存。
                </p>
                {options && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save('options');
                    }}
                  >
                    <fieldset className="native-fieldset" disabled={locked}>
                      <label>
                        主音量：{Math.round(options.masterVolume * 100)}%
                        <input
                          aria-label="主音量"
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(options.masterVolume * 100)}
                          onChange={(event) =>
                            setOptions({
                              ...options,
                              masterVolume: Number(event.target.value) / 100,
                            })
                          }
                        />
                      </label>
                      <label>
                        音乐音量：{Math.round(options.musicVolume * 100)}%
                        <input
                          aria-label="音乐音量"
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(options.musicVolume * 100)}
                          onChange={(event) =>
                            setOptions({
                              ...options,
                              musicVolume: Number(event.target.value) / 100,
                            })
                          }
                        />
                      </label>
                      <label>
                        渲染距离（区块）
                        <input
                          aria-label="渲染距离"
                          type="number"
                          required
                          min={2}
                          max={64}
                          value={options.renderDistance}
                          onChange={(event) =>
                            setOptions({
                              ...options,
                              renderDistance: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="toggle-row">
                        <span>游戏内全屏设置</span>
                        <input
                          aria-label="全屏游戏"
                          type="checkbox"
                          checked={options.fullscreen}
                          onChange={(event) =>
                            setOptions({
                              ...options,
                              fullscreen: event.target.checked,
                            })
                          }
                        />
                      </label>
                      <p className="hint">
                        启动时以上方“启动显示方式”为准；选择“跟随游戏设置”后使用这里的全屏选项。
                      </p>
                    </fieldset>
                  </form>
                )}
              </section>
            )}
          </div>
          {section !== 'options' && world && world.gameRules.length > 0 && (
            <details className="manager-advanced world-rules-details">
              <summary>
                高级游戏规则 <span>{world.gameRules.length} 项</span>
              </summary>
              <section className="card game-rules">
                <div className="section-heading">
                  <div>
                    <h3>
                      游戏规则 <span>{world.gameRules.length}</span>
                    </h3>
                    <p>
                      读取此世界已有规则；未识别的文本规则只读，不自动添加缺失规则。
                    </p>
                  </div>
                  <input
                    aria-label="搜索游戏规则"
                    placeholder="搜索规则名称…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <fieldset
                  className="native-fieldset rules-grid"
                  disabled={locked || world.hardcore}
                >
                  {world.gameRules
                    .map((rule, index) => ({ rule, index }))
                    .filter(({ rule }) =>
                      `${ruleNames[rule.key] ?? ''} ${rule.key}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map(({ rule, index }) => (
                      <label key={rule.key} className="rule-row">
                        <span>
                          <strong>{ruleNames[rule.key] ?? rule.key}</strong>
                          <small>{rule.key}</small>
                        </span>
                        {rule.kind === 'boolean' ? (
                          <input
                            aria-label={ruleNames[rule.key] ?? rule.key}
                            type="checkbox"
                            checked={rule.value === 'true'}
                            onChange={(event) =>
                              setWorld({
                                ...world,
                                gameRules: world.gameRules.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        value: String(event.target.checked),
                                      }
                                    : item,
                                ),
                              })
                            }
                          />
                        ) : (
                          <input
                            aria-label={ruleNames[rule.key] ?? rule.key}
                            type="text"
                            inputMode={
                              rule.kind === 'integer' ? 'numeric' : 'text'
                            }
                            readOnly={rule.kind === 'text'}
                            value={rule.value}
                            onChange={(event) =>
                              setWorld({
                                ...world,
                                gameRules: world.gameRules.map((item, i) =>
                                  i === index
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              })
                            }
                          />
                        )}
                      </label>
                    ))}
                </fieldset>
                <p className="hint">
                  较高的随机刻速度、命令执行上限等可能增加运行负担。与上方世界配置一起保存。
                </p>
                <button
                  className="primary"
                  disabled={locked || world.hardcore}
                  onClick={() => void save('world')}
                >
                  保存世界设置与规则
                </button>
              </section>
            </details>
          )}
          {section !== 'options' && worldId && world && (
            <details className="manager-advanced">
              <summary>此世界的配置备份</summary>
              <ConfigBackups
                key={`${id}:${worldId}`}
                service={service}
                id={id}
                worldId={worldId}
                locked={locked}
                dirty={dirtyWorld || dirtyOptions}
                onRestore={restore}
              />
            </details>
          )}
          {section !== 'world' && options && (
            <details className="manager-advanced">
              <summary>音画配置备份</summary>
              <ConfigBackups
                key={`${id}:options-backups`}
                service={service}
                id={id}
                locked={locked}
                dirty={dirtyWorld || dirtyOptions}
                onRestore={restore}
              />
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
