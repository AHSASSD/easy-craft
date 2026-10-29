# 水星迫降整合包安装与资源安装弹窗验收

后续修复：[本地导入修复记录](PACK_IMPORT_FIX_2026-10-28.md)。本篇记录的是首次手动补录验收；旧验证库现已按用户要求清理，该历史文件的恢复信息已随新版程序提供。

日期：2026-10-28。使用本项目编译的 `src-tauri/target/debug/easy-craft.exe` 执行真实安装，未使用 PCL/HMCL 程序代装。自动化通过桌面 WebView 原生桥上传原包、检查计划并调用宿主安装任务，随后核对真实游戏库与文件。PCL/HMCL 源码仅作只读参考。

## 真实安装结果

- 原始文件：`C:/Users/小萌新一只/Downloads/[Mercury landing-水星迫降]-7.0b+8.zip`。
- Minecraft 1.12.2，Forge 14.23.5.2860。
- 测试库：`E:/PCL2 code comparison/easy-craft/.native/mercury-install`。
- 实例：`617dbe22-0feb-4e55-9eec-27a8c5a9ffc2`，名称「水星迫降重置版 · 安装验证」。
- 游戏目录：测试库下 `instances/617dbe22-0feb-4e55-9eec-27a8c5a9ffc2/game`。
- 107 个清单平台文件全部解析、下载并暂存：105 个 JAR 与 2 个资源 ZIP；覆盖文件一并提交，最终内容步骤 802/802。游戏目录有 105 个 Mod、3 个资源包（含覆盖内容）、任务及配置文件。
- 宿主返回 `task.status=succeeded`、`phase=pack-committed`，实例已真实登记。仅任务成功不会代替实例与文件核对。
- 原 ZIP 安装前后 SHA-512 一致：`681258d803b8b623bb5550fc0cd32612625a8b5fb2ad6397cd9a7fcaa23a3b2fbca1c318f05464e82b83458185807a68d1d595f14f8368f048d30b0c017804b4`。
- 现有账号、用户 Minecraft 版本和存档未改动。

`scripts/open-mercury-validation.ps1` 打开上述独立验证库；直接打开 EXE 仍使用其正常数据目录，不会自动切换到验证库。推荐内存显示来自整合包清单，不擅自改全局配置。

### 历史文件的明确补录

项目 386143 / 文件 3404975 的 CurseForge 公开元数据为空、下载接口返回 404。本轮没有跳过必需文件，也没有用最新版本替换。找回官方 ForgeCDN 同一文件 ID 下的 `lootbags-2.5.8.7.jar`（302653 字节），并核对 SHA-1 `762294ef3baf7a09d9d875e6218895fa51b89d43` 后，以验证库 `pack-recovery/386143-3404975.json` 明确补录。

补录记录绑定项目、文件 ID、大小、文件名与 SHA-1；与下载结果不符时拒绝安装。这是本次历史文件的人工恢复记录，尚未实现所有失效文件的自动找回。没有该记录且上游仍失效时，新数据目录会准确报缺失而中止。

普通文件使用 CurseForge 官网公开元数据和受限官方 CDN 下载；接口未提供发布者哈希时，不声称已获得发布者哈希证明。本地 SHA-512 用于冻结已下载缓存、检查后续复制一致性。恢复文件另核对明确的 SHA-1。

## 安装流程与范围

参考 PCL 的 CurseForge 清单/overrides 分类、HMCL 的 Forge 安装器格式探测及旧版 universal/profile 合并思路独立实现：

- `PCL-2.99.0.0/Plain Craft Launcher 2/Modules/Minecraft/ModModpack.vb`。
- `HMCL/HMCL-main/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeInstallTask.java`、`ForgeOldInstallTask.java`。

流程：安全归档预览 → 固定项目/文件 ID → 最多 6 个并发下载与有界重试 → 官方原版运行依赖 → Forge 安装器校验及 profile/universal 提取 → 库文件准备 → 覆盖内容及清单文件暂存 → 事务登记实例。ZIP 按内部结构识别资源包/光影，不全放到 mods。元数据和文件缓存复用；必需文件缺失中止，失败保留有效缓存，实例事务回滚。

官方 Forge 来源不可用时，允许使用 BMCLAPI/NJU 的限定 Maven 镜像并核对该来源提供的 SHA-1；不会把镜像校验值称为 Mojang 签名。每次重定向均重新检查 HTTPS、域名、凭据、端口及镜像路径。资源归档的条目上限独立于整合包上限，真实落盘仍检查路径与链接边界。

本轮新增 **CurseForge Minecraft 1.12.2 / Forge** 清单包安装。支持旧 install/versionInfo 与新 envelope 中无 processors 的安装器；不执行任意处理器或脚本，不据此宣称所有 CurseForge、现代 Forge、NeoForge 整合包均可安装。原有 MRPACK 原版/Fabric 路径保留。

## 任务和资源 UI

- 安装时游戏库出现半灰待安装项，名称、当前步骤百分比及条目计数来自真实宿主任务；点击可查看逐步进度。完成后用真实实例替换。失败/取消保留可查看的任务状态。
- 逐步显示清单文件、运行依赖、Forge 依赖、内容暂存和提交等阶段；没有总量的步骤显示等待统计。百分比为当前阶段条目完成比例，不是预计剩余时间。颜色变化是步骤进展提示，不伪装下载字节总百分比。
- 点击具体资源版本立即弹出安装位置面板；可选实例，数据包还需选目标世界。既有预检及确认步骤继续生效，Forge 实例正确标注加载器。
- 另一选项「仅保存到文件夹」直接调用系统文件夹选择器。固定选定的 Modrinth 版本及文件，核对 SHA-1/SHA-512、拒绝同名覆盖；不创建实例、不装依赖、不自动启用。取消不报错、不写目标。
- 当前文件夹保存支持 Modrinth；CurseForge 来源明确显示未支持。整合包继续走全新实例流程。

## 验证证据

- Rust 单元/回归：104 通过，12 项需特定环境的测试默认忽略。新增归档边界、CurseForge 清单固定 ID/加载器/覆盖目录、下载来源白名单测试。
- 单独执行真实已安装包启动准备测试通过：49 个 classpath 依赖、2 个 native 归档、Java 8 要求、LaunchWrapper 主类和 FMLTweaker 参数均核对。**未启动 Minecraft，未验证进入主菜单或完整游玩。**
- 前端测试 91 通过；浏览器 E2E 14 通过；类型检查、ESLint、Clippy、桌面构建通过。
- 真实桌面资源面板：1120×720 窗口，选择在线数据包版本打开弹窗，系统目录选择先取消、再实际保存 `veinminer-1.3.4.zip`，核对任务成功且没有新增实例。

证据目录（均在本项目下）：

- `output/playwright/mercury-install/preview.json`、`result.json`。
- `output/playwright/mercury-install/01-pending.png`、`01-step-progress.png`、`02-result.png`。
- `output/playwright/resource-target/01-install-target.png`、`02-save-only.png`、`03-saved.png`、`verification.json`。
- `.native/pack-native-tests.log`、`pack-tests.log`、`pack-e2e.log`、`pack-types.log`、`pack-lint.log`、`pack-clippy.log`、`pack-build.log`、`mercury-prepare.log`。

复现入口：`scripts/verify-mercury-pack.mjs` 会执行真实安装，应使用隔离数据并注意重复运行会新增实例；`scripts/verify-resource-target.mjs` 运行真实桌面资源保存验证。历史恢复记录保存在上述验证库中，不包含账号令牌。
