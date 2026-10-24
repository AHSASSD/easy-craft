# Easy Craft · 独立竖栏与实例管理（开发中）

Windows x64 的 Minecraft Java 启动器。按已确认的 UI 方案使用“最左竖栏 → 实例/分类列表 → 右侧详情”，支持真实实例、下载、账户、内存和世界配置；亮色与暗色主题均可使用。进度与未完成项见 [实施记录](docs/IMPLEMENTATION_STATUS.md)，当前包版本标识仍为 V0.3.1。

## 运行桌面版

最新已验证的开发程序位于 `src-tauri/target/debug/easy-craft.exe`。现有 release 程序与安装包属于此前构建，不能代表本轮竖栏和资源安装进度；整版发布待后续验收。无需完整 Visual Studio；CLion、PyCharm 或其他编辑器都可以继续使用。

从 PowerShell 启动开发模式：

```powershell
cd 'E:\PCL2 code comparison\easy-craft'
npm ci
.\scripts\native.ps1 dev
```

本机工具已放在 `E:\PCL2 code comparison\build-tools\easycraft`。脚本只设置当前进程环境，不修改全局 PATH。新机器需要先准备同样的工具，见 [Windows 工具链](docs/WINDOWS_TOOLCHAIN.md)。

浏览器预览仍可使用 `npm run dev`，地址 <http://127.0.0.1:1420/>。**浏览器里的真实下载、登录和启动按钮禁用，不会用模拟功能代替。**

## 功能与边界

- 最左侧为游戏库、设置、下载三个入口，中间栏目随入口切换；支持真实实例搜索、重命名、打开目录、右键菜单、调整/折叠栏目与导航记忆。主题偏好持久化，本地背景目前只预览，跨重启保存待完成。演示资料与模拟启动保留于 `/?demo=1`，也可从设置进入。
- 实例的模组、资源与光影、截图页读取真实文件；Fabric Mod 可启停，ZIP/JAR 可受限导入，截图提供缩略图及查看。系统选择器支持最大 512 MiB 的流式导入，小文件/拖放入口仍限 16 MiB；未知文件保留，运行与占用时拒绝修改。
- “实例 → 存档”读取真实 Java 存档：和平/简单/普通/困难、难度锁定、允许命令、默认游戏模式、时间、天气，以及存档已有的布尔/整数游戏规则。规则支持中英文搜索，其他文本规则只读；不会凭空添加版本不支持的规则。
- 音画设置独立读写实例的 options.txt：主音量、音乐音量、渲染距离、全屏。默认游戏模式不覆盖现有玩家的独立模式。
- 保存前校验文件版本与世界占用状态，备份原配置后只修改受支持字段；区块、背包及未知 NBT 字节保持不变。备份位于实例 game/.easycraft-backups/{UUID}/，并显示具体路径；它是配置备份，不是完整世界备份。外部游戏停在主菜单时无法可靠检测，保存前请退出该实例。
- 极限模式世界只读；26.1 更改后的难度布局暂不支持，读取时明确提示且不会覆盖文件。当前按存档目录名称显示列表。
- 左下角头像直接打开账户弹窗，选择正版登录或离线登录，保存后显示当前真实身份；不必在下载中心寻找账户配置。
- 头像默认从皮肤头部裁切并叠加帽子层。正版档案返回的官方皮肤会缓存；离线账户可以选择 64×64 或 64×32 PNG。离线图片只改变启动器头像，不会替换游戏内皮肤；没有可用皮肤时显示默认头像。
- “设置 → 启动”提供 Java 路径/检测与实际物理/可用内存，支持自动分配、手动滑块与数值输入；启动时应用最大堆上限并记入日志。
- 内存整理默认关闭：可单独整理启动器工作集，或在确认后整理当前权限可访问进程的工作集；还可选择启动前执行系统整理。不会结束进程、提权或清空内核缓存，不保证固定释放量，可能短暂卡顿。
- “下载 → 原版游戏”提供官方正式版本清单与原版/Fabric 独立实例安装。
- 下载中的五类 Modrinth 内容提供真实搜索、版本与依赖信息。Mod、资源包、光影包可选择目标实例，预览必需依赖与文件后安装；大小、SHA-1/SHA-512 验证后提交，来源记录和事务恢复保护已有文件。只新增或保留同内容文件，不自动替换旧版；Mod 首轮支持已验证的 Fabric 路径，复杂或不明确条件会拒绝。资源包/光影包下载不等于在游戏中启用。
- 数据包须选择实例及具体世界，校验存档版本、客户端数据包格式与 pack.mcmeta 后提交到该世界 datapacks/，保持 level.dat 不变；存档页可回读文件和进入下载。已验证文件校验与世界隔离，尚未验收游戏内启用和效果。
- Fabric 稳定版本查询、官方元数据与 Maven 下载、依赖 SHA-1 校验、锁定配置、独立实例和实际启动。不会自动附带 Fabric API 或其他 Mod。
- 本地 ZIP/MRPACK 先检查内容；在线整合包可选择 Modrinth 版本与归档，校验下载后进入同一预览。有效的原版/Fabric MRPACK 可预览全部文件与可选项，确认后下载、校验并创建独立实例。处理客户端条件及覆盖层级，完成后才原子加入游戏库；失败或中断有记录可恢复，不覆盖已有实例。当前只下载 Modrinth CDN 内容，其他加载器/来源或不明确兼容条件会拒绝；普通 ZIP/CurseForge 清单仅识别。
- 基础资源仅允许 Mojang/Minecraft 官方域名，Fabric 依赖仅允许其官方元数据/Maven 域名；禁止重定向到其他来源，逐文件 SHA-1 校验成功才提交缓存。
- 限制并发、连接超时、有限重试、取消、临时文件续传和已校验缓存复用。损坏缓存会重新下载，实例清单只在安装成功后提交。
- 每个真实实例使用独立的 game/natives 目录；不删除或覆盖用户存档。
- 检测所选 Java 的实际主版本与 64 位架构，启动前要求匹配实例元数据。已提供工作区 Java 21 和 Java 25；选择其他可信运行时需填写其 java.exe 完整路径。
- Microsoft 设备码授权 → Xbox → XSTS → Minecraft 令牌、所有权与档案校验；启动时可刷新账户。
- 离线账户：无需 Microsoft 登录或 Client ID，自定义 3–16 位英文、数字或下划线用户名，按 Java 离线规则生成稳定 UUID。资源完整时启动器无需联网；首次下载、缺失或损坏资源的修复仍需网络。离线身份不代表正版授权，不能通过正版服务器或 Realms 的验证。
- 刷新令牌只由 Rust 使用 Windows DPAPI 加密保存在 account.dpapi；前端不接收令牌，普通设置不存密码或 Client Secret。
- 通过参数数组启动真实 Java 进程，展示退出状态与最近 200 条脱敏日志；可以结束游戏进程。

**关闭启动器会结束由它启动的游戏，请先保存并退出世界。**

离线模式已经实际启动 Minecraft 1.21.1 的 Java 进程并观察到 OpenAL 引擎初始化，结束任务可回收进程。尚未创建世界、操作存档或验证多人游戏。Microsoft 本人授权与正版启动仍未进行端到端验收。

旧式 minecraftArguments、任意继承版本、Forge/NeoForge/Quilt、实例文件复制、实例级 Java/内存覆盖、自动下载 Java 的 UI 和第三方插件均未实现。仍按 [UI 设计计划](docs/UI_DESIGN_PLAN.md) 分步推进，不宣称整版已完成。

## 使用顺序

1. 进入“设置 → 启动”，检测并保存 Java。Minecraft 1.21.1 使用 Java 21。
2. 点击左下角头像 → “离线登录” → 输入例如 `EasyPlayer` 的用户名 → “使用离线账户”，无需 Client ID。
3. 需要正版账户时：同一弹窗选择“正版登录”，首次在登录配置中填写自有应用的 Client ID，点击登录并在微软官方页面授权。应用需支持个人账户、公共客户端设备授权，并能访问 Minecraft API；不要使用其他启动器的 Client ID。授权结果自动轮询，关闭弹窗不中断。
4. 选择官方游戏版本，以及原版或 Fabric 后安装；Fabric 可刷新稳定版本。安装不要求先登录；成功后才显示为“已安装的真实实例”。
5. 已保存离线账户或已完成 Microsoft 授权、Java 匹配后，在游戏库选择实例并点击“启动游戏”。需要调整已有世界时进入“存档”；音画位于“实例设置”。退出游戏后重新读取、调整并保存。
6. 在设置中选择自动/手动内存、按需开启整理；系统整理仅在内存不足时使用，机械硬盘尤其可能卡顿。

离线用户名区分大小写，决定玩家 UUID。更名或改用正版身份可能导致背包、进度、宠物归属不同；不会自动迁移存档身份。

Client ID 不是 Client Secret。请不要向聊天或配置文件发送密码、令牌或 Client Secret。注册指引见 [Microsoft 官方设备码流程](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code)。

## 构建与检查

```powershell
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
npm run test:e2e
.\scripts\native.ps1 check
.\scripts\native.ps1 test
.\scripts\native.ps1 clippy
.\scripts\native.ps1 fmt
.\scripts\native.ps1 build
.\scripts\native.ps1 bundle
```

- `build`：前端生产构建；native.ps1 build：可直接运行的调试桌面程序。
- `bundle`：Release 程序和 NSIS 安装包，输出到 `src-tauri/target/release/bundle/nsis/`。
- Edge 流程测试要求本机安装 Microsoft Edge。普通 Rust 测试不连接认证服务。
- 公网集成检查单独执行，避免把联网结果混同于普通单测：

```powershell
.\scripts\native.ps1 test -Integration metadata
.\scripts\native.ps1 test -Integration install
node scripts/smoke-native.mjs
.\scripts\native.ps1 test -Integration offline
node scripts/smoke-native.mjs debug --launch-offline
.\scripts\native.ps1 test -Integration fabric
node scripts/smoke-native.mjs debug --launch-offline --fabric
.\scripts\native.ps1 test -Integration resources
node scripts/smoke-native.mjs debug --cached --resources --install-resources --install-dependencies --install-shader --launch-offline --fabric
node scripts/smoke-native.mjs debug --cached --resources --install-datapack
node scripts/smoke-native.mjs debug --cached --native-picker
powershell -ExecutionPolicy Bypass -File scripts/fetch-modpack-fixture.ps1
node scripts/smoke-native.mjs debug --cached --public-pack --launch-offline
node scripts/smoke-native.mjs debug --cached --online-pack --launch-offline
node scripts/smoke-native.mjs debug --cached --background
```

安装集成测试会在 `.native/integration` 下载真实官方 1.21.1 资源、验证缓存修复和参数构造，不启动游戏。`-Integration offline` 将 HTTP 路由到不可用的本地代理，验证完整缓存无需联网即可准备离线参数。桌面检查使用该测试目录与临时 WebView2 调试端口，验证窗口、IPC、Java、官方清单、正版模式登录限制和离线配置；加 `--launch-offline` 才会实际启动游戏，观察初始化后结束进程。测试临时修改并还原测试目录的设置，不修改用户 data 目录，不进行 Microsoft 登录。

当前结果见 [独立竖栏方案实施记录](docs/IMPLEMENTATION_STATUS.md)。此前结果保留于 [V0.3.1 验证与边界](docs/V0.3.1-VERIFICATION.md)、V0.3-VERIFICATION.md、V0.2-VERIFICATION.md 和 OFFLINE_MODE.md。

## 架构

```text
src/app/                 应用装配、原生桥接适配器、页面组合
src/components/          标题栏、弹窗、皮肤头像
src/features/            真实实例首页、世界设置、账户/内存、下载、演示
src/core/contracts.ts    演示数据与服务契约
src/core/native-contracts.ts 原生服务 DTO 与接口
src/core/navigation.ts   分类、实例标签、搜索和位置记忆
src/core/plugins/        插件内核、权限、生命周期与回收
src/plugins/official/    演示实例、主题、模拟启动、原版服务
src-tauri/src/host.rs    设置、实例事务、任务和游戏进程
src-tauri/src/auth.rs    设备授权、令牌交换/刷新与 DPAPI
src-tauri/src/net.rs     官方来源、校验下载、续传与重试
src-tauri/src/minecraft.rs 元数据、平台规则、参数与 Java
src-tauri/src/fabric.rs  Fabric 元数据、Maven 依赖与启动配置
src-tauri/src/memory.rs  实际内存检测、自动分配与可选工作集整理
src-tauri/src/packs.rs   ZIP/MRPACK 内容检查（不写入实例）
src-tauri/src/modpack.rs MRPACK 固定计划、客户端文件、覆盖层级与新实例事务
src-tauri/src/content.rs 本地内容扫描、启停、导入、截图与目录入口
src-tauri/src/resources.rs Modrinth 搜索、项目和兼容版本查询
src-tauri/src/resource_install.rs 固定依赖计划、JAR 条件校验、SHA-512 与事务恢复
src-tauri/src/worlds.rs  受限 NBT 原位修改、音画选项、占用锁与配置备份
src-tauri/src/skins.rs   官方皮肤下载缓存、离线头像 PNG 校验
scripts/native.ps1      工作区便携工具链入口
tests/                  前端单元/组件与浏览器流程测试
```

原生 UI 只消费 NativeService，后续修改界面不需要重写下载或认证逻辑。只有随程序打包的可信官方插件可以执行，没有第三方代码沙箱。

## 数据与文档

开发脚本将真实数据放在项目的 data 目录。直接运行桌面程序时默认使用程序旁的 data；可以通过当前进程的 EASYCRAFT_DATA_DIR 指定其他目录。原生数据与浏览器演示的 localStorage 分开，V0.1 数据不会自动转换成真实实例。

- settings.json：Client ID、Java 路径、内存/分配模式/整理开关、启动模式、离线用户名；无令牌。旧配置保留手动内存值，整理默认关闭，原账户数据保留。
- instances.json：真实安装成功的实例清单。
- account.dpapi：当前 Windows 用户绑定的加密账户，不能当作跨机器迁移文件。
- assets/libraries/versions：官方资源缓存；instances/{UUID}/game：独立游戏目录。

设置或实例清单无效时保留原文件并报错；不要通过删除 data 来解决单个账户问题，应使用界面的“退出正版账户”。

[架构](docs/ARCHITECTURE.md) · [插件 API](docs/PLUGIN_API.md) · [执行记录](docs/PROGRESS.md) · [原生依赖](docs/NATIVE_DEPENDENCIES.md) · [路线图](docs/ROADMAP.md)
