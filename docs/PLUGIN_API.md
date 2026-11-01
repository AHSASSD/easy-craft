# 官方插件 API 1.0.0

2026-11-01：新增正式的声明式插件管理，契约、受支持能力、安装/启停/实例范围、系统回收站与恢复模式见 [插件管理实施记录](PLUGIN_MANAGEMENT_2026-11-01.md)。这与下文源码装配的官方内核 API 分离；外部包不能取得 `PluginContext` 或执行代码。

V0.2 新增 official.vanilla，提供 native@1.0.0 服务。其契约位于 src/core/native-contracts.ts，封装原生状态、官方清单、设置、Java、设备登录、安装、启动与取消。2026-10-26 的 UI 改造新增 official.layout，共五个官方插件共享原有生命周期机制，API 版本仍为 1.0.0。原生桥接本身也是可信打包模块；浏览器明确拒绝原生操作。

NativeService 的公共状态没有访问令牌或刷新令牌；认证与进程安全校验在 Rust 重复执行，不能依赖 UI 禁用按钮来授权启动。

Phase 0 仅接收由源码装配的 Plugin 对象，没有扫描插件目录、读取 JS 文件或执行 ZIP 的路径。

## 清单

每个插件必须有唯一 id、三段 version、apiVersion、requires、provides、permissions。apiVersion 目前必须是 `1.0.0`；requires/provides 的键是服务契约 ID，值是精确版本，暂不支持范围。

```ts
{
  id: 'official.themes',
  version: '0.1.0',
  apiVersion: '1.0.0',
  requires: { preferences: '1.0.0' },
  provides: { themes: '1.0.0' },
  permissions: ['services', 'themes']
}
```

## 生命周期

`setup(ctx)` 必选；`start(ctx)`、`stop(ctx)` 可选，可以返回 Promise。setup 需注册清单声明的所有服务。一个清单中的依赖不能指向自身提供的服务；未声明依赖不能 getService。为资源在创建时立即 addDisposable，不能等 start 成功后再登记。

`load(plugins)` 是批次事务；失败回滚当前批次。运行中再次 load 会拒绝，先 stop 后可重新 load。stop 保留 host.preferences，移除所有插件服务、页面、主题与事件监听。当前版本没有单插件热卸载，避免破坏仍在运行的依赖插件。

## 上下文能力

| 方法                       | 权限                     | 行为                                                 |
| -------------------------- | ------------------------ | ---------------------------------------------------- |
| getService(id)             | 声明在 requires/provides | 按类型契约读取服务，缺失时报错                       |
| registerService(id, value) | services                 | 必须在 provides，验证方法形状，禁止覆盖              |
| onEvent(name, listener)    | events                   | 自动登记取消订阅                                     |
| emitEvent(name, data)      | events                   | 校验已知事件载荷后分发                               |
| registerPage({id,title})   | pages                    | 注册可在开发者工具中检查的页面扩展元数据，停止时移除 |
| registerTheme(theme)       | themes                   | 注册内置主题定义，停止时移除                         |
| addDisposable(fn)          | 无额外权限               | 逆序释放资源；已停止上下文拒绝调用                   |

页面扩展当前是元数据注册验证，未提供第三方页面渲染 SDK。服务契约表见 src/core/contracts.ts。新增契约需同步类型表、内核方法形状校验、清单白名单和测试。

## 事件

- `instances:changed`: `{ count: number }`，非负整数。
- `launch:progress`: LaunchProgress，固定步骤/状态，percent 可选且 0–100。
- `kernel:ready`: `{ plugins: string[] }`。

事件监听器应同步、短小且自行处理业务错误；异步任务应通过服务与 AbortSignal 管理，不在事件回调中创建不受控后台任务。

## 版本与安全

### 本地声明式插件（2026-10-31）

扩展侧栏支持导入布局／主题 JSON 包，格式及边界见 `docs/AUTOSAVE_AND_LOCAL_PLUGINS_2026-10-31.md`，示例见 `docs/plugins/compact.ecplugin.json`。这是偏好配置插件，不是可执行的第三方 `Plugin.setup` 实现；不会获得原生服务、文件系统或任意代码执行权限。社区目录与外部脚本运行时仍未开放。

### 版本目录布局（2026-10-30）

`NativeInstance.versionFolder` / Rust `Instance.version_folder` 是可选的受管版本文件夹名。存在时，游戏目录为 `storageRoot（或 dataRoot）/.minecraft/versions/<versionFolder>`；已选 `.minecraft` 不重复嵌套，关闭隔离时游戏目录为 `.minecraft`。缺失时保留旧实例布局；本地引用安装仍使用原引用目录。插件应使用实例目录解析服务，不能硬编码 `instances/<id>/game`。版本目录内的文件操作、安装事务及路径展示需使用同一布局；共享下载缓存仍由宿主管理。

### 官方布局与启动检查（2026-10-26）

`src/plugins/official/layout.json` 配置官方导航顺序、概览区块顺序以及经典／紧凑排版参数。修改源码中的文件后需要重新构建；当前不读取外部布局文件，也未开放第三方页面执行。宿主继续管理账号、实例、任务与恢复入口。

`NativeService.modCheck(id, force?)` 对应只读的 `native_mod_check`，返回 `{ instanceId, issues, unchecked, details? }`。`force: true` 绕过解析与报告缓存；默认核对文件清单及大小、时间属性后增量读取。`details` 包含检查时间、范围、完整性、归档数、重读数、复用数与耗时。宿主内缓存有界、仅存声明，重启后失效。Fabric 复用安装约束求解；Forge/NeoForge 核对 TOML 与已声明的内嵌 Mod。复杂 Maven 限定版本、桥接和动态服务身份等明确列入未完成范围，不能用没有问题等同全面通过。原版中的 JAR 也会提示核对加载器。检查不授权文件修改，不会自动安装、升级或禁用模组。

UI 在选择实例后防抖检查，相关内容变更后更新，返回应用时节制复核；切换实例子页不再触发扫描。启动前做轻量确认并复用未变化报告；检查中提供“直接启动”，警告仍提供“仍然启动”。设置可关闭选中后的自动检查。旧响应不会覆盖新实例。未提供操作系统实时目录监听、立即终止已开始的原生检查或自动修复计划。调用者必须验证报告的 instanceId，并验证当前检查上下文。

`openFolder(id, folder)` 使用宿主当前生效的隔离/共享目录。`folder` 仅允许 `game/mods/saves/screenshots/resourcepacks/shaderpacks`，不接受任意路径。缺失目录返回可读错误，不自动创建目录。

### 本地模组快捷操作（2026-10-30）

`NativeService.modDetails(id, file, revision)` 读取本地 JAR 的 Fabric、Forge、NeoForge 或旧版 `mcmod.info` 声明，返回基本条目、实际路径、声明信息或未识别原因。详情只展示本地声明，不代表依赖检查已通过。`revealMod(id, file, revision)` 在 Windows 资源管理器中选中该文件。两者对应 `native_mod_details`、`native_mod_reveal`。

`removeMod(id, file, revision)` 对应 `native_mod_remove`：只接受当前实例 mods 目录内已识别的条目，校验文件版本后移入游戏目录 `.easycraft-mod-trash/<UUID>/`，保留原始 JAR 与 `restore.json`，返回回收文件路径；不永久删除、不覆盖现有文件。没有回收区管理 UI。启停继续使用 `toggleContent`（重命名 `.jar` / `.jar.disabled`）。列表修改和本地导入无需人工勾选“游戏已关闭”，仍受宿主任务、已知游戏运行状态及文件系统约束。未识别文件可查看详情与定位，启停和删除保持只读。

条目 revision 增加卷与文件 ID，防止同大小、同修改时间的替换文件被误操作。客户端必须把当前条目 revision 原样传回；过期版本拒绝操作，需刷新列表。成功启停、删除会更新 `modRevision`，使启动检查重新核对。后端单项操作只核对所选 JAR；修改后 UI 刷新列表与检查，查看详情和定位不触发列表重读。

### Mod 安装前预检（2026-10-26）

`NativeService.planResources()` 对 Fabric Mod 先解析固定的在线安装计划、下载到缓存并验证文件，再把新增与已启用模组一起检查。返回的 `ResourcePlan.preflight` 使用 `{ instanceId, issues, unchecked }`，确认前不写入目标实例。

本地 JAR 通过 `previewModFile(id, file)`（流式上传）或 `pickModPlan(id)`（原生文件选择器，取消返回 null）生成同样的计划，`local: true` 表示本地来源，不代表 Modrinth 项目。仅接受 Fabric JAR；资源包、光影与截图流程保持原有契约。

UI 显示问题后由玩家选择；有问题时必须明确勾选，再调用 `installResources(token, true)`。未确认会拒绝，但保留该计划供玩家确认。安装器只放行冻结报告中已确认的声明问题，继续检查实例内容快照、缓存哈希、同名覆盖、任务互斥和事务提交，确认不能绕过这些保护。计划十分钟内有效。

Fabric 安装预检现在汇总支持范围内同一候选方案的多个声明问题；不能求解的格式仍返回错误，`unchecked` 解释未知文件、运行时冲突和 Java／加载器资料的未确认范围。在线资源解析无法构造一致计划时仍返回错误；本地预检不自动根据任意 Mod ID 搜索或下载依赖，也不升级、禁用或删除旧模组。原有底层导入接口保留兼容性，应用中的 Mod 选择、文件输入和拖入入口均使用新的预检流程。此能力由已打包的官方原生服务提供，尚未开放外部 JS 插件执行。

### 下载来源与 Forge 安装器（2026-10-26）

资源查询可选择 `source: 'curseforge'`（目前仅 Fabric Mod），未指定时仍为 Modrinth。`resourceDetail(project, kind, gameVersion, { allVersions: true })` 用于跨 Minecraft 大版本浏览；实际安装继续验证准确目标版本。`planResources` 可携带 CurseForge 来源和项目 ID，原生层固定项目／文件归属、下载地址和哈希，再返回同样的预检计划。授权密钥只在宿主读取，不进入服务契约。

`forgeVersions(game)` 返回官方推荐／最新安装器版本；`downloadForge(game, loader)` 保留仅下载校验语义。新增 `installForge(game, name, loader)` 经官方安装器创建独立实例，处理器在隔离目录执行，支持取消、失败回滚及任务日志。原版下载页的 Forge 按钮使用安装接口。实测范围与限制见 [整合包与加载器验收](PACK_LOCATION_AND_LOADERS_2026-10-30.md)。

下载目录联动新增 `fabricGames()` 与 `fabricCatalog(game)`；后者返回全部加载器版本及稳定推荐项，保留旧 `fabricVersions(game)` 的稳定列表语义。`forgeVersions(game)` 还返回 Maven 目录中的 `versions` 和受支持的 `gameVersions`。UI 只采纳当前类型／游戏的响应，版本选择不自动触发安装。见 [目录联动记录](DOWNLOAD_CATALOGS_2026-10-26.md)。

### 整合包安装与资源保存（2026-10-28）

整合包预览的 `install` 含 `forgeVersion`、`neoforgeVersion`、`curseFiles`（固定的项目 ID / 文件 ID 对）、`recommendedMemoryMb` 与 `storageRoot`。MRPACK 支持原版、Fabric、Forge、NeoForge 的单一加载器声明，CurseForge Forge 清单包也走官方处理器安装流程；保留 1.12.2 的旧格式分支，不承诺所有历史安装器格式。必需文件不能自动跳过。历史文件缺失可使用绑定 ID、文件名、大小和 SHA-1 的内置恢复记录或本地补录；没有已验证记录则中止。当前已内置水星迫降所需的 `386143 / 3404975` 恢复信息，见 [后续修复](PACK_IMPORT_FIX_2026-10-28.md)。公开接口未给发布者哈希时仅说明本地 SHA-512 缓存固定。

`pickPackDestination(token, reset?)` 打开系统目录选择器并将位置绑定到当前整合包计划；取消不修改已有选择，`reset: true` 恢复默认。安装接口不接受任意路径字符串。`NativeInstance.storageRoot` 持久保存自选游戏库位置，实际内容位于其 `instances/<id>/game`，共享运行库与下载缓存仍在宿主数据目录。自选实例的回收区也位于自选游戏库，避免跨盘移动失败。外部引用版本继续仅允许移出记录。

`NativeStatus.task` 可含 `pendingInstance` 和最多 32 个 `steps`（阶段、消息、已完成/总数、完成状态与可选 fallback 状态）。仅提交实例后移除待安装行；失败行保留任务入口。阶段百分比来自计数，不等于全任务耗时百分比。

`NativeService.saveResource(project, version, filename)` 经原生文件夹选择器保存指定 Modrinth 文件，取消返回 `false`；固定归属与 SHA-1/SHA-512，拒绝覆盖，不安装依赖或自动启用。当前不提供 CurseForge 保存模式。真实安装及限制见 [水星迫降验收记录](MERCURY_PACK_AND_RESOURCE_TARGET_2026-10-28.md)。

### 执行约束

实例管理新增 `NativeService.removeInstance(id, archive)`：默认操作由 UI 明确确认；仅移出游戏库返回 null，自有目录移入启动器 `instance-trash` 返回实际路径。引用目录不能回收，宿主强制检查任务与目录所有权。无永久删除、自动清空或自动恢复 UI，见 [实例管理记录](INSTANCE_MANAGEMENT_2026-10-29.md)。

服务契约版本与插件发布版本独立。API 兼容只采用精确匹配。权限是官方模块约束，不是 JS 沙箱。不要把外部源码作为 Plugin 对象载入；正式 SDK 需另行设计隔离、权限审核、签名和故障隔离。
