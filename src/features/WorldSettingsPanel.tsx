import { useEffect, useState } from 'react';
import { Globe2, Volume2, ShieldCheck, RefreshCw } from 'lucide-react';
import { useEditor, useNavigationGuard } from './UnsavedChanges';
import { WorldDatapacks } from './WorldDatapacks';
import type {
  ClientOptions,
  NativeService,
  WorldEntry,
  WorldSettings,
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
  const [closed, setClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [worldBase, setWorldBase] = useState('');
  const [optionsBase, setOptionsBase] = useState('');
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
        service.worlds(id),
        service.options(id),
      ]);
      setWorlds(entries);
      receiveOptions(opts);
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
    if (running) return;
    void Promise.allSettled([service.worlds(id), service.options(id)]).then(
      (results) => {
        if (disposed) return;
        if (results[0].status === 'fulfilled') {
          setWorlds(results[0].value);
          setWorldId(results[0].value[0]?.id ?? '');
        }
        if (results[1].status === 'fulfilled') receiveOptions(results[1].value);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') setError(String(failure.reason));
      },
    );
    return () => {
      disposed = true;
    };
  }, [id, service, running]);
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
      if (!closed || running)
        throw new Error('请先退出游戏并勾选“确认游戏已关闭”');
      let backup = '';
      if (kind === 'world' && world) {
        backup = await service.saveWorld(id, worldId, world);
        receiveWorld(await service.world(id, worldId));
      }
      if (kind === 'options' && options) {
        backup = await service.saveOptions(id, options);
        receiveOptions(await service.options(id));
      }
      setMessage(backup ? `已保存，原文件已备份：${backup}` : '已保存配置。');
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
  useEditor({
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
  const locked = busy || running;
  return (
    <div className="world-settings">
      <div className="section-heading">
        <div>
          <h2>{section === 'options' ? '实例音画设置' : '存档与启动前设置'}</h2>
          <p>修改当前实例的真实配置，进入游戏前生效。</p>
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
      {running && (
        <p className="notice">
          游戏或任务运行中，配置修改已锁定。退出后重新读取再修改。
        </p>
      )}
      <div className="preflight-note">
        <ShieldCheck size={18} />
        <div>
          <strong>保存前自动备份</strong>
          <p>
            不修改区块、背包或未知字段。请先退出从其他启动器打开的同一实例；外部游戏停留主菜单时无法可靠检测。
          </p>
        </div>
      </div>
      <label className="toggle-row">
        <span>我已关闭此实例的 Minecraft，允许保存配置</span>
        <input
          aria-label="确认游戏已关闭"
          type="checkbox"
          checked={closed}
          disabled={locked}
          onChange={(event) => setClosed(event.target.checked)}
        />
      </label>
      <div className="world-columns">
        {section !== 'options' && (
          <section className="card">
            <h3>
              <Globe2 size={18} />
              世界配置
            </h3>
            <label>
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
            {!worlds.length && (
              <p className="hint">
                此实例尚无可读取的存档。先在 Minecraft
                中创建世界，再回来调整；不会自动创建空存档。
              </p>
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
                className="native-fieldset"
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
                    {['和平', '简单', '普通', '困难'].map((value, index) => (
                      <option key={value} value={index}>
                        {value}
                      </option>
                    ))}
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
                  disabled={!closed}
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
                    <span>全屏游戏</span>
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
                  <button className="primary" type="submit" disabled={!closed}>
                    保存音画设置
                  </button>
                </fieldset>
              </form>
            )}
          </section>
        )}
      </div>
      {section !== 'options' && world && world.gameRules.length > 0 && (
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
                              ? { ...item, value: String(event.target.checked) }
                              : item,
                          ),
                        })
                      }
                    />
                  ) : (
                    <input
                      aria-label={ruleNames[rule.key] ?? rule.key}
                      type="text"
                      inputMode={rule.kind === 'integer' ? 'numeric' : 'text'}
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
            disabled={locked || !closed || world.hardcore}
            onClick={() => void save('world')}
          >
            保存世界设置与规则
          </button>
        </section>
      )}
    </div>
  );
}
