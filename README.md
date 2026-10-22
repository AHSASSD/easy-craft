# Easy Craft V0.2 · 离线账户增强

Windows x64 的 Minecraft Java 原版启动器。保留 V0.1 双栏界面与演示流程，新增受限的 Rust 原生服务；本轮先完善功能，视觉调整可以后续独立进行。

## 运行桌面版

构建后的程序位于 `src-tauri/target/release/easy-craft.exe`。可直接运行，无需完整 Visual Studio；CLion、PyCharm 或其他编辑器都可以继续使用。

从 PowerShell 启动开发模式：

```powershell
cd 'E:\PCL2 code comparison\easy-craft'
npm ci
.\scripts\native.ps1 dev
```

本机工具已放在 `E:\PCL2 code comparison\build-tools\easycraft`。脚本只设置当前进程环境，不修改全局 PATH。新机器需要先准备同样的工具，见 [Windows 工具链](docs/WINDOWS_TOOLCHAIN.md)。

浏览器预览仍可使用 `npm run dev`，地址 <http://127.0.0.1:1420/>。**浏览器里的真实下载、登录和启动按钮禁用，不会用模拟功能代替。**

## 功能与边界

- 左侧仍为明确标注的演示实例；深浅主题、搜索/排序/收藏、重命名与资料复制、可调整栏宽和本地背景保留。
- “下载中心”新增原版工作区：官方正式版本清单、实例安装、Java 检测、正版账户和真实游戏进程入口。
- 下载仅允许 Mojang/Minecraft 官方资源域名，禁止重定向到其他来源；逐文件 SHA-1 校验，校验成功才提交缓存。
- 限制并发、连接超时、有限重试、取消、临时文件续传和已校验缓存复用。损坏缓存会重新下载，实例清单只在安装成功后提交。
- 每个真实实例使用独立的 game/natives 目录；不删除或覆盖用户存档。
- 检测所选 Java 的实际主版本与 64 位架构，启动前要求匹配实例元数据。已提供工作区 Java 21 和 Java 25；选择其他可信运行时需填写其 java.exe 完整路径。
- Microsoft 设备码授权 → Xbox → XSTS → Minecraft 令牌、所有权与档案校验；启动时可刷新账户。
- 离线账户：无需 Microsoft 登录或 Client ID，自定义 3–16 位英文、数字或下划线用户名，按 Java 离线规则生成稳定 UUID。资源完整时启动器无需联网；首次下载、缺失或损坏资源的修复仍需网络。离线身份不代表正版授权，不能通过正版服务器或 Realms 的验证。
- 刷新令牌只由 Rust 使用 Windows DPAPI 加密保存在 account.dpapi；前端不接收令牌，普通设置不存密码或 Client Secret。
- 通过参数数组启动真实 Java 进程，展示退出状态与最近 200 条脱敏日志；可以结束游戏进程。

**关闭启动器会结束由它启动的游戏，请先保存并退出世界。**

离线模式已经实际启动 Minecraft 1.21.1 的 Java 进程并观察到 OpenAL 引擎初始化，结束任务可回收进程。尚未创建世界、操作存档或验证多人游戏。Microsoft 本人授权与正版启动仍未进行端到端验收。

旧式 minecraftArguments、继承版本、Forge/Fabric 等加载器、整合包解压导入、自动下载 Java 的 UI 和第三方插件均未实现。不同现代版本仍需匹配的 Java；当前真实安装集成验收目标是 1.21.1。

## 使用顺序

1. 进入“下载中心”，检测 Java，并保存原生配置。Minecraft 1.21.1 使用 Java 21。
2. 普通本地游戏：将“启动账户模式”选为“离线账户”，输入例如 `EasyPlayer` 的用户名，点击“保存原生配置”。无需 Client ID。
3. 需要正版账户时：改选 Microsoft 模式，配置自有应用的 Client ID，获取设备码并在微软官方页面授权。应用需支持个人账户、公共客户端设备授权，并能访问 Minecraft API；不要使用其他启动器的 Client ID。授权结果自动轮询，切换页面不中断。
4. 选择官方版本并安装。安装本身不要求先登录；成功后才显示为“已安装的真实实例”。
5. 已保存离线账户或已完成 Microsoft 授权、Java 匹配后，点击真实实例的“启动游戏”。启动身份显示在实例列表上方；左侧“模拟启动”始终只用于演示。

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
node scripts/smoke-native.mjs release --launch-offline
```

安装集成测试会在 `.native/integration` 下载真实官方 1.21.1 资源、验证缓存修复和参数构造，不启动游戏。`-Integration offline` 将 HTTP 路由到不可用的本地代理，验证完整缓存无需联网即可准备离线参数。桌面检查使用该测试目录与临时 WebView2 调试端口，验证窗口、IPC、Java、官方清单、正版模式登录限制和离线配置；加 `--launch-offline` 才会实际启动游戏，观察初始化后结束进程。测试临时修改并还原测试目录的设置，不修改用户 data 目录，不进行 Microsoft 登录。

实际验证结果见 [V0.2 验证记录](docs/V0.2-VERIFICATION.md) 和 [离线账户验证](docs/OFFLINE_MODE.md)。

## 架构

```text
src/app/                 应用装配、原生桥接适配器、页面组合
src/components/          标题栏、弹窗
src/features/            原版工作区、演示任务与导入预览
src/core/contracts.ts    演示数据与服务契约
src/core/native-contracts.ts 原生服务 DTO 与接口
src/core/plugins/        插件内核、权限、生命周期与回收
src/plugins/official/    演示实例、主题、模拟启动、原版服务
src-tauri/src/host.rs    设置、实例事务、任务和游戏进程
src-tauri/src/auth.rs    设备授权、令牌交换/刷新与 DPAPI
src-tauri/src/net.rs     官方来源、校验下载、续传与重试
src-tauri/src/minecraft.rs 元数据、平台规则、参数与 Java
scripts/native.ps1      工作区便携工具链入口
tests/                  前端单元/组件与浏览器流程测试
```

原生 UI 只消费 NativeService，后续修改界面不需要重写下载或认证逻辑。只有随程序打包的可信官方插件可以执行，没有第三方代码沙箱。

## 数据与文档

开发脚本将真实数据放在项目的 data 目录。直接运行桌面程序时默认使用程序旁的 data；可以通过当前进程的 EASYCRAFT_DATA_DIR 指定其他目录。原生数据与浏览器演示的 localStorage 分开，V0.1 数据不会自动转换成真实实例。

- settings.json：Client ID、Java 路径、内存、启动模式、离线用户名；无令牌。旧配置默认保持 Microsoft 模式，原账户数据保留。
- instances.json：真实安装成功的实例清单。
- account.dpapi：当前 Windows 用户绑定的加密账户，不能当作跨机器迁移文件。
- assets/libraries/versions：官方资源缓存；instances/{UUID}/game：独立游戏目录。

设置或实例清单无效时保留原文件并报错；不要通过删除 data 来解决单个账户问题，应使用界面的“退出正版账户”。

[架构](docs/ARCHITECTURE.md) · [插件 API](docs/PLUGIN_API.md) · [执行记录](docs/PROGRESS.md) · [原生依赖](docs/NATIVE_DEPENDENCIES.md) · [路线图](docs/ROADMAP.md)
