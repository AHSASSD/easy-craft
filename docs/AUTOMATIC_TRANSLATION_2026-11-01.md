# 自动匹配、下载和启用汉化

替换上一版打开网站的“获取汉化资源”，现在点击实例设置中的“自动安装汉化”即可在启动器内完成流程。手动 ZIP 导入保留。

## 实际流程

1. 固定当前实例；读取游戏版本、加载器、实际游戏目录和 options 修订号。扫描已启用的 JAR，只读取模组声明和资源命名空间，忽略 `.jar.disabled`，标明无法读取的文件。模组列表不上传到网络。
2. 依据版本族及 Fabric/Forge（含 NeoForge）选择 CFPA 对应发布文件；读取 CFPA 官方 GitHub `autobuild` 发布索引中的文件名、大小、SHA-256 和固定下载 URL。验证实际客户端 `version.json` 的资源包格式，旧版 1.10.2/1.12.2 使用已知格式 2/3。
3. 从 HTTPS 官方来源下载，逐跳检查重定向（固定 CFPA 仓库及其 GitHub 资源 CDN），限制大小，校验 SHA-256；失败最多重试三次，其中一次使用已有的直连 HTTP/1 备用连接。索引请求限时 12 秒，资源请求限时 45 秒、连续 20 秒无数据则重试。不会关闭 TLS 证书验证或执行远程代码。
4. 使用已有压缩资源安全检查、资源包格式检查，确认存在与当前实例匹配的中文资源命名空间。零匹配或格式不兼容时不写入实例，也不伪称安装成功。
5. 导入至实际游戏目录 `resourcepacks/EasyCraft-CFPA-<hash>.zip`，资源文件保持官方原始字节及授权信息。修改前备份 options；只更新语言及资源包启用列表，不改任务、脚本、Mod、存档和其他配置。
6. 中文语言与启用状态直接生效于下次启动；1.12 及更早资源包标识不带 `file/`，1.13 起带前缀。把汉化置于最低外部资源优先级，玩家原有包的顺序保持，已有的整合包专用译文仍可覆盖它。再次安装相同内容不重复添加启用条目、不改写相同配置。更新时旧文件保留，只替换由启动器管理的启用条目。

扫描、索引、下载、校验、导入五阶段进入底部任务及日志，支持现有取消。实例/任务互斥规则继续适用。下载期间 options 被外部修改则拒绝覆盖；启用失败回滚本轮新增的包，使用既有文件句柄保护核对归属及内容，无法安全回滚时明确提示保留的位置。已有玩家文件永不覆盖。

## 覆盖范围

接入原始 CFPA 发布包的直接匹配（1.10.2、1.12.2、1.16、1.18、1.19、1.20、1.21、26.1 版本族，最终还需通过具体客户端格式检查）。Fabric 使用其独立版本；1.19 没有对应的直接 Fabric 发布文件，不借用 Forge 文件。

这提供模组通用汉化，不是所有整合包的专用汉化补丁安装器。没有接入跨版本合并/转换，因此不保证同版本族内所有小版本都能直接使用；例如当前 26.2 不会被擅自降配到 26.1 原包。未匹配项可能已经自带中文，匹配命名空间也不代表每个词条完整翻译。UI 明确显示 CFPA 匹配情况及未识别文件，不生成虚假汉化完成率。手册、任务书、脚本等专用补丁没有统一可靠版本接口，本轮不自动覆盖。

## 来源核对

- [CFPA 官网](https://cfpa.site/)及[官方翻译仓库](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)提供整合汉化包，而非要求逐个 Mod 搜索 MC 百科。
- 运行时发布索引固定为 `https://api.github.com/repos/CFPAOrg/Minecraft-Mod-Language-Package/releases/tags/autobuild`；下载使用该索引的 SHA-256，不信任任意输入 URL。
- [官方自动汉化项目](https://github.com/CFPAOrg/I18nUpdateMod3)及其 `src/main/java/i18nupdatemod/I18nUpdateMod.java`、`src/main/resources/i18nMetaData.json`核对了旧版资源包标识差异、版本/加载器资源划分，以及跨版本合并属于独立处理逻辑。本轮自行实现下载和配置，不复制或安装其可执行 Mod。

## 验证证据

- 146 项后端测试、105 项前端测试、14 项端到端测试通过。新增后端回归覆盖来源/摘要/重复资产拒绝、版本与格式匹配、禁用模组跳过、安装幂等、配置外部变化、旧版标识、损坏资源列表回滚及取消。类型检查、ESLint、Clippy、桌面 debug 构建通过。
- 真实 Tauri 窗口：隔离目录 `.native/auto-translation/8773c273-69a7-40b6-afbb-12f06e63d401`，使用真实 1.21.1 客户端、Fabulously Optimized 6.5.0 的真实模组集，以及本地 Create/JEI 的只读副本。测试实例元数据隔离，不冒充已完整安装的整合包启动验证。
- Fabric 实际匹配 `cloth-config2`，自动下载 `Minecraft-Mod-Language-Modpack-1-21-Fabric.zip`（528607 字节），SHA-256 `147e478c5420a07c36dd6aac65f24a151b0b039409aea2e8ccf9e6da7e0ddd0e`。
- 通用包实际匹配 `jei`，下载 `Minecraft-Mod-Language-Modpack-1-21.zip`（3527805 字节），SHA-256 `298170904acf4727110f9e4b8654085c90242b18b953aceae634c72d349d554a`。只有 Create 的初次测试零匹配，正确未改实例；新增 JEI 副本后匹配成功。
- 校验了实际 options 的中文/启用列表、玩家资源包顺序、原音量及未知配置保留；重复安装修订号不变。扫描中真实取消后配置不变。故意损坏测试缓存后重新下载成功，下载过程中一次真实中断触发备用重试并成功。
- 1120×720 暗色及 800×560 浅色、减少动画、键盘焦点检查通过，无横向溢出。未启动 Minecraft，未使用个人账号或操作个人存档，未验证游戏内所有文本的翻译效果。
- 截图及 `verification.json`：`output/playwright/auto-translation/8773c273-69a7-40b6-afbb-12f06e63d401/`。主要日志：`output/auto-translation-real-forge.log`、`output/auto-translation-recovery.log`、`output/auto-translation-cancel.log`、`output/auto-translation-final-ui.log`。

产物：`src-tauri/target/debug/easy-craft.exe`。
