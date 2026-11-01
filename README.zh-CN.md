# Easy Craft

[English](./README.md) | [简体中文](./README.zh-CN.md)

面向 **Windows x64** 的 Minecraft Java 版启动器，使用 React、TypeScript、Tauri 和 Rust 构建。在统一工作区管理游戏实例、整合包、本地内容及存档设置，支持浅色和深色主题。

**开发版本：0.3.1。** 当前源码包含截至 2026 年 11 月 1 日的更新，开发构建尚未完成整版正式发布验收。Microsoft 登录仍需配置 Easy Craft 自有应用 Client ID 并完成真人授权验证；CurseForge API 需要单独配置密钥。

## 功能

- 实例库支持搜索、目录分组、重命名、本地版本扫描导入、隔离设置和导航记忆。
- 原版、Fabric 安装及文档支持范围内的 Forge/NeoForge 安装器，ZIP/MRPACK 整合包检查与安装。下载提供校验、临时文件续传及安装事务保护。
- Modrinth 资源浏览、版本选择、安装目标和依赖预览。模组、资源包、光影及指定世界的数据包分别检查兼容性。
- 自动选择 Java：优先复用本机兼容运行时，缺少时下载并校验 Mojang 官方 Windows x64 运行时。保留手动指定的实例 Java，支持取消和重试。
- 实例级 Java、内存设置，自动内存分配和可选工作集整理。
- 模组管理、截图、受支持的存档及音画设置、配置备份预览与恢复。
- 整合包安装后按需补充 CFPA 汉化资源；先检查已有汉化，汉化失败不撤销成功的游戏安装。
- 离线身份与 Microsoft 设备码认证实现；刷新令牌由 Windows DPAPI 加密。
- 任务进度、失败建议和可预览诊断摘要。复制前过滤已知身份、令牌和本地路径，分享前仍需检查。
- 声明式本地工具、外观及实例检查插件，支持启停、依赖检查与恢复模式。

## 当前限制

- 尚未完成使用本项目自有应用注册的 Microsoft 真人登录端到端验收。离线身份不代表正版授权，不能通过正版服务器或 Realms 验证。
- 自动 Java 对应 8、16、17、21、25；本轮完整下载、校验、取消重试与复用实测的是 Java 21，该运行时测试没有启动 Minecraft。
- 通用模组汉化不保证覆盖全部词条、整合包任务书或脚本补丁；部分模组已自带中文。
- 配置备份**不是完整世界备份**。修改世界文件前应退出游戏；极限世界只读，不支持的世界格式拒绝写入。
- 下载资源包、光影或数据包不等于游戏内已启用；兼容检查覆盖声明信息，不能预测所有运行时问题。
- 插件尚不提供任意第三方代码执行环境。
- **关闭启动器会结束由它启动的游戏，请先保存并退出世界。**

具体支持组合与验证证据见带日期的[实施记录](docs/IMPLEMENTATION_STATUS.md)。早期文档只描述各自日期的状态。

## 本地运行

先准备 Node.js/npm 及[Windows 工具链](docs/WINDOWS_TOOLCHAIN.md)。本项目使用 `../build-tools/easycraft` 下的便携工具链，不包含在 Git 仓库中。PowerShell 包装脚本只设置当前进程路径，不修改全局 PATH。

在克隆后的仓库目录执行：

```powershell
npm ci
.\scripts\native.ps1 -Action dev
```

最新本地构建的桌面程序位于 `src-tauri/target/debug/easy-craft.exe`。旧 release 程序或安装包可能与当前源码不同。

浏览器预览：

```powershell
npm run dev
```

打开[本地预览](http://127.0.0.1:1420/)。真实下载、登录与游戏启动需要桌面版，浏览器不会模拟成功。演示入口为 `/?demo=1`。

## 首次使用

1. 安装游戏版本、导入支持的整合包，或扫描已有安装。安装前无需先登录。
2. 通过头像或启动按钮选择账号。离线名称为 3–16 位英文字母、数字或下划线，区分大小写。
3. 启动实例。自动 Java 模式会查找或准备兼容运行时；使用自定义运行时时，在实例设置选择可信的 `java.exe`。
4. 按需调整内存、隔离、本地内容及受支持的世界设置。修改存档配置前退出游戏。

更改离线名称或切换账号身份会改变玩家 UUID，可能影响背包、进度及物品归属，启动器不会自动迁移玩家数据。

## 应用凭据

发行构建前，通过 `EASYCRAFT_MICROSOFT_CLIENT_ID` 设置自有应用的公开 GUID。新配置和旧配置中的空 Client ID 使用打包值，已有非空配置保持原样。它是 **Client ID，不是 Client Secret**。发行方仍需完成应用注册和真人登录验收，参考[Microsoft 设备码流程文档](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code)。

CurseForge 使用宿主环境变量 `EASYCRAFT_CURSEFORGE_API_KEY`，启动时读取。不要将密钥写入源码、浏览器配置、截图或公开 Issue。仓库不包含凭据文件和本地游戏数据。

## 构建与验证

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
.\scripts\native.ps1 -Action check
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action clippy
.\scripts\native.ps1 -Action fmt
.\scripts\native.ps1 -Action build
.\scripts\native.ps1 -Action bundle
```

- 原生包装脚本的 `build` 生成调试桌面程序；`bundle` 生成 release 程序及 `src-tauri/target/release/bundle/nsis/` 下的 NSIS 安装包。
- 浏览器测试需要 Microsoft Edge。联网或系统集成测试与普通测试分开执行，运行前先查看对应验证脚本。
- 最新记录：**150 项后端、112 项前端、14 项浏览器测试通过**。20 项后端集成默认忽略，其中官方 Java 运行时集成已单独执行并通过。
- 仅验证运行时的桌面检查：为当前进程设置 `EASYCRAFT_RUNTIME_UI_CHECK=1`，执行 `node scripts/verify-usability-final.mjs`。脚本使用隔离夹具，不启动游戏。

## 架构与数据

`src/app` 装配服务，`src/features` 提供界面流程，`src/core/native-contracts.ts` 定义原生接口。`src-tauri/src` 下的 Rust 模块处理认证、下载、安装、运行时准备及文件操作。

开发时使用项目 `data/`；独立程序默认使用程序旁的 `data/`，可用 `EASYCRAFT_DATA_DIR` 指定其他位置。`settings.json` 和 `instances.json` 保存配置，`account.dpapi` 绑定当前 Windows 用户。原生数据与浏览器演示存储分离。无效配置会保留并报错，不要通过删除整个数据目录处理账号问题。

## 文档

- [架构](docs/ARCHITECTURE.md) · [实施状态](docs/IMPLEMENTATION_STATUS.md) · [路线图](docs/ROADMAP.md)
- [自动 Java](docs/AUTOMATIC_JAVA_RUNTIME_2026-11-01.md) · [启动条件](docs/FIRST_USE_LAUNCH_READINESS_2026-11-01.md)
- [汉化与 Java 更新](docs/PACK_AUTO_TRANSLATION_AND_JAVA_2026-11-01.md) · [插件管理](docs/PLUGIN_MANAGEMENT_2026-11-01.md)
- [插件 API](docs/PLUGIN_API.md) · [运行时声明](docs/THIRD_PARTY_NOTICES.md) · [原生依赖声明](docs/NATIVE_THIRD_PARTY_NOTICES.txt)

详细实施记录目前主要使用简体中文。
