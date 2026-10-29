# 本地版本导入与侧栏修正

后续默认方式和 Forge/NeoForge 支持范围已有变化，以 [已有安装直接添加与真实启动验证](LOCAL_REFERENCE_FORGE_2026-10-27.md) 为准；本文独立副本流程继续保留。

后续修复已将预览拆为只读入口发现，逐文件索引在确认后执行，并重做扫描结果 UI；当前行为详见 `LOCAL_SCAN_FIX_2026-10-27.md`。

2026 年 10 月 27 日凌晨按本聊天授权实施。保留既有未提交改动、账号及游戏数据，未推送或提交仓库。

## 已实现

- 修正“搜索实例”垂直偏移。根因是通用 `label > input:not([type='checkbox'])` 的 `margin-top: 8px` 优先级高于原搜索框样式；使用精确搜索框选择器消除该间距，并统一输入框高度/行高。真实桌面在 100%、125% 缩放下验证文字输入框与图标中心对齐。
- “我的游戏”旁加号提供“导入本地整合包”和“扫描/导入本地版本”，支持方向键、Home/End、Esc、焦点恢复和外部点击关闭。
- 侧栏底部、首页和加号菜单的整合包入口直接打开系统 ZIP/MRPACK 文件选择窗口，选择成功直接显示现有安全预览；取消不跳页、不创建实例。原来的拖入整合包流程保留。
- 本地版本通过系统文件夹窗口选择 `.minecraft` 根目录、`versions` 目录或具体版本目录。统一扫描、预览、选择、命名与确认，不要求手动输入任意文件路径。
- 检查实际 JSON、基础 JAR、继承关系和加载器。支持版本目录名、JSON 文件名与版本 ID 不一致；通过 JAR 的内置 `version.json` 优先识别实际 Minecraft 版本。继承目录按 JSON ID 解析，存在多个同 ID 基础版本时拒绝猜测。
- 支持现代原版与 Fabric 转换为 Easy Craft 独立实例。Forge、NeoForge、Quilt、未知启动主类、自定义原版继承、旧式 `minecraftArguments` 格式明确显示不可导入。没有将 Forge 安装器下载能力当作 Forge 启动内核。
- 导入前联网核对官方清单/元数据；原版 JAR、依赖库、资源索引和资源对象、Fabric 库依据官方 SHA-1 验证后复用本地文件，不匹配或缺失时从既有官方下载路径补齐。复用是复制，不将源文件硬链接到可写目标。
- 仅复制常见游戏内容目录及明确列出的 options/servers 文件。独立实例可保留 Mods、配置和存档等内容，原启动器账号、令牌与启动配置不导入；第三方 JVM/Java/内存设置不沿用。UI 显示实际游戏目录、文件数、大小及复制说明。
- 不覆盖、移动或删除源目录。后续扫描加速改动将预览改为大小、修改时间和文件身份索引，版本 JSON 仍保留内容摘要；确认时锁定源文件，计算 SHA-512 并核对复制结果，前后复核文件树及元数据。预览不是所有游戏文件的密码学快照；正常文件变化要求重扫。目标使用既有逐文件事务日志、清单校验、原子实例登记及启动恢复机制，失败回滚当前实例，已完成的批次实例保留。详见 `SCAN_ISOLATION_2026-10-27.md`。
- 来源标识持久化，重扫可识别已导入版本并禁选。实例同名自动加序号；源目录重复不因改名绕过。任务进度、错误及取消继续使用底部任务与日志。

## 支持边界

- 扫描只读、无需网络；实际导入需要联网核对官方版本和 Fabric 元数据。尚未实现完全离线导入。
- 不全盘扫描，用户指定范围最多枚举 256 个版本目录；指定某个版本时保留该明确选择。继承最多 16 层，内容目录最多 24 层、约两万个条目，每次导入最多 32 个版本。
- 单个游戏内容文件最多 512 MiB，每个实例内容最多 2 GiB；超过时明确提示，不能静默丢弃多余数据。大于这些范围的存档暂需另行迁移。
- 复制目录：`mods`、`config`、`saves`、`resourcepacks`、`shaderpacks`、`screenshots`、`datapacks`、`defaultconfigs`、`kubejs`、`scripts`。根目录文件：`options.txt`、`optionsof.txt`、`optionsshaders.txt`、`servers.dat`、`servers.dat_old`。其他自定义根目录内容不自动复制，说明中已列出范围。
- 自动判断“版本隔离目录”或“共享游戏目录”，确认页显示实际采用的目录。未知外部自定义 gameDir 不通过读取原启动器私有配置自动猜测。
- 链接/重解析点不跟随；版本内容被占用、损坏、不可读、循环继承、缺少基础版本等明确失败。正常游戏库已有实例不受失败候选影响。

## 验证结果

- Rust：87 项通过，7 项环境相关集成默认忽略；新增本地扫描、根目录/versions/指定目录合流、目录名与 ID 差异、继承、歧义、目录数量限制、损坏 JSON/JAR、取消、超大文件、快照变化、重复来源、同名、事务回滚和官方哈希复制校验。
- 前端：81 项通过；新增加号键盘/焦点/外部关闭，本地扫描取消、无效响应、不支持/重复项禁选，以及显式勾选与确认范围后才提交。模态框内部也提供任务进度与取消按钮，不要求先关闭弹窗才能操作任务栏。
- 浏览器端到端：14 项通过。
- 类型检查、Rust Clippy、ESLint、格式检查与桌面构建通过。
- `node scripts/verify-local-import.mjs` 驱动真实 EXE、系统文件/文件夹选择窗口，验证整合包取消与预览、原生目录扫描、预览变化拒绝、任务取消、确认后批量导入、重复标记、源内容保留，以及浅色主题、125% 缩放与 800×540 最小窗口。文件夹选择自动化使用真实 Win32 Button 的 BM_CLICK，避免误把同 ID 的文件列表项当作按钮；只允许操作本工作区 EXE 和自建 fixtures。
- 真实 Minecraft 1.21.1 与 Fabric 0.16.14 资源来自项目此前已下载并验证的 `.native/integration` 缓存，在隔离目录构建两种本地安装结构。源目录与文件名经过改名，Fabric 继承基础版本；确认后两个实例均真实出现在游戏库，共享资源验证复用、`options.txt` 与配置按原字节复制，合成 `launcher_accounts.json` 标记未复制。
- Forge/损坏 JSON、账户文件标记、微型 JAR 等是合成故障夹具，未当作真实已运行游戏。真实导入使用官方客户端与实际依赖，不是 UI 演示数据。
- 额外集成验证：`scripts/native.ps1 -Action test -Integration local`，通过 `EASYCRAFT_IMPORT_TEST_DATA` 指定上述隔离数据。原版 71 项、Fabric 79 项 classpath 文件全部可定位，资源校验、原生库解压和启动命令生成通过。没有启动 Minecraft，也没有登录真实账号。

## 产物与复现

- 程序：`src-tauri/target/debug/easy-craft.exe`。
- 桌面截图与结构化记录：`output/playwright/local-import/`，包括 `00-centered-search.png`、`01-add-menu-centered-search.png`、`02-direct-pack-preview.png`、`03-real-local-scan.png`、`04-imported-library.png`、缩放/最小窗口/浅色菜单截图、`verification.json`、`imported-instances.json`。
- 复现：先保留已有 `.native/integration` 的已验证 1.21.1/Fabric 缓存，构建后执行 `node scripts/verify-local-import.mjs`。脚本仅使用隔离测试目录；不会把测试实例写入用户正式数据目录。
- 命令准备复验：从 `imported-instances.json` 读取 `data` 设置 `EASYCRAFT_IMPORT_TEST_DATA`，再执行 `scripts/native.ps1 -Action test -Integration local`。该验证只准备命令，不启动游戏。
