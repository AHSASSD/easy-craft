# 已有安装直接添加、Forge / NeoForge 启动与真实验证

2026-10-27。本轮修复用户报告的“1.16.5 导入很慢，最终超过扫描深度或文件数量限制”，并实现已安装 Forge / NeoForge 的启动。保留原有未提交修改，没有提交或推送。

## 问题与解决

旧流程把“添加到游戏库”实现为完整独立复制，确认后再次递归枚举并复制存档、Mod 等游戏内容，触发副本的深度/数量限制；还强制要求确认联网补齐。即使原安装已经能用 PCL 启动，也必须经过这些步骤。

现在默认选择“直接添加已有版本”：只保存合并后的启动配置快照和原安装位置，不遍历复制世界，不下载依赖，不导入账号或第三方启动器私有配置。因此直接添加不再受世界内容的递归复制限制。事务发布后真实实例进入游戏库，重启仍可恢复；重复来源会标记并阻止再次添加。

启动时复用原安装的客户端、libraries、assets 和原游戏目录。UI 明示：**添加本身只登记；玩家启动后 Minecraft 会在所选原游戏目录正常读写**。这不是独立副本。原目录被移动、删除或失去访问权限时会明确报错，不会偷偷下载安装或改写原启动器配置。

“复制为独立副本”仍是显式选项，保留原版/Fabric 的事务复制、官方资源校验、按需修复、取消与回滚。该模式仍有容量、数量和深度限制，超限会说明；Forge/NeoForge 的处理器安装与独立复制尚未实现，在 UI 中禁用此组合。

## 启动与版本隔离

- 解析有界继承链，保留基础 JVM/游戏参数，按 Maven 库身份替换继承中重复版本；基础版本目录名与 JSON ID 可以不同，歧义和循环不猜测。
- 支持现有 ModLauncher / BootstrapLauncher 配置、Windows 10/11 的官方规则、模块路径与占位符。
- 检查库文件位置、客户端和资源索引。真实运行发现 FML 还按约定路径读取 JSON 普通库清单外的 universal/client、Minecraft srg/extra 产物，现也检查这些文件；缺失时列出具体路径，不声称已修复。
- BootstrapLauncher 的忽略列表补入实际基础客户端文件名，避免重复加载原版客户端。
- 本地版本默认优先使用匹配的全局 Java；不匹配时在有界的常见本机目录寻找对应 64 位主版本，也允许实例手动指定。没有自动下载 Java。
- Windows 长 JVM 参数使用临时参数文件，按系统 ANSI 代码页编码，修复中文路径下模块找不到的问题。游戏身份参数不写入参数文件，进程结束/取消后删除临时文件；不可表示的字符在命令长度允许时使用直接参数。
- 版本隔离沿用原安装发现的目录：开启指向该原版本文件夹，关闭指向原 Minecraft 根目录。切换不搬移或合并存档/Mod；应用自己安装的独立实例保持既有目录模型。
- Forge/NeoForge 的 Mod 声明分析尚未接入，预检明确显示未检查，不用 Fabric 分析器制造“全面通过”。

## 扫描与界面

扫描只访问选中根目录、versions 下有界候选、版本 JSON/JAR 和已知游戏内容入口。世界仅检查 saves 直接子目录中的 level.dat/level.dat_old，不扫描 region、Mod 内容或整盘。

进一步测量确认 ZIP 9 反复在 JAR 中央目录 seek，普通 BufReader 的 seek 会丢弃缓冲，stream_position 也会反复查询文件位置。增加局部缓冲定位适配器，保留标准库的边界检查；没有新增依赖、整包读取进内存或跳过 JAR 验证。合成 ZIP 回归验证 1,024 个条目仍能准确读取，底层读/定位总次数小于 512，而不是每个条目都产生系统调用。

同机真实目录 63 个候选：此前约 11.4–13.5 秒，本轮内核约 5.4–6.3 秒；最终桌面系统目录选择到扫描结果约 5.2 秒。33 个可添加候选与 30 个不支持/异常候选全部可查看原因。“可添加”不等于所有第三方 Mod 已通过兼容分析。

用户进一步指出单版本不应等待整库扫描后，增加具体版本目录的快捷检查：无继承时完全不枚举兄弟版本；有继承时只建立用于消除 ID/目录别名歧义的 JSON 索引，检查所选版本与其父版本的 JAR/内容。实测原版 1.16.5 内核单版本检查约 429 ms，Forge/NeoForge 含父版本 JSON 索引约 1.7–1.8 秒，登记约 61–121 ms。实际系统文件夹选择到单版本结果约 1.73 秒，包含系统窗口自动化开销。**已添加后的日常启动不重新扫描整库，也没有每次导入步骤。** 游戏 JVM 初始化及资源/Mod 加载另计。

扫描面板保留摘要、筛选、搜索、紧凑列表、展开详情及固定确认区；区分扫描完成与实际导入。新版默认方式无需勾选联网许可。最小 800×540 窗口、125% 缩放时确认区仍可见，添加方式文字不换行。底栏保留任务进度、取消、失败和结果入口。

## 真实验证证据

来源：本机 `%APPDATA%/.minecraft`，不是合成游戏。正式游戏库和账号文件没有写入测试实例。

1. `scripts/native.ps1 -Action test -Integration local-reference`：真实原版 1.16.5、Forge 1.16.5-36.2.34、Forge 1.20.1-47.2.0、NeoForge 21.1.139 完成直接登记、持久恢复及依赖/命令准备。单个登记约 66–95 ms，含原生库解包与 Java 检查的准备约 0.87–1.97 秒。1.20.1 Forge 仅检查准备，本轮未实际启动。
2. `scripts/verify-real-local-scan.mjs`：实际桌面系统文件夹选择并扫描 C 盘来源，UI 选择原版/Forge/NeoForge 后一次添加 3 个实例约 153 ms。每个实例目录只有启动配置快照，没有复制世界。119 个版本 JSON/游戏设置文件的前后哈希一致。普通窗口、最小窗口/125%、浅色主题、关闭再打开结果、搜索/筛选/选择及日志链接通过。
3. `scripts/verify-local-launch.mjs`：得到用户明确启动测试授权后，将所需 4,328 个真实客户端、库和资源文件**复制**到 `.native/launch-smoke/<uuid>/minecraft`，使用新的空游戏目录、离线测试身份 LaunchTest、Java 8/21。没有复制个人世界、Mod 或账号，没有把原目录当运行目录。通过真实桌面 `native_launch`，原版 1.16.5、Forge 36.2.34 和 NeoForge 21.1.139 均实际显示主菜单，保存日志和所测试 Java 窗口截图，测试后结束并回收进程。不是仅拼接命令或运行 `java -version`。
4. 测试资源源文件的 4,328 项 SHA-256 前后相同。主菜单测试不等于已验证所有个人整合包、世界和服务器。实际进程/截图记录包含额外的稳定等待时间，不作为启动速度基准。
5. `scripts/verify-local-import.mjs`：真实 1.21.1 原版/Fabric 0.16.14 的独立副本导入、资源复用、内容复制、损坏与不支持夹具、预览后源文件变化、重复、取消、版本隔离、真实上传 50% 进度和回滚，以及文件选择/取消、搜索框、键盘菜单、窗口/主题通过。

产物与记录：

- 桌面程序：`src-tauri/target/debug/easy-craft.exe`
- 准备报告：`output/playwright/local-reference/real-preparation.json`
- 桌面扫描：`output/playwright/local-scan/desktop/verification.json` 与同目录截图
- 主菜单与日志：`output/playwright/launch-smoke/`，`verification.json` 区分自动渲染信号和人工图像核对
- 副本回归：`output/playwright/local-import/verification.json`
- Rust 95 项通过、10 个显式集成测试默认忽略；另单独运行真实引用集成。前端 83 项、浏览器 E2E 14 项通过。类型构建、Clippy、Rust fmt、ESLint、Prettier 通过。忽略本地运行/游戏数据目录，避免静态检查递归枚举验证缓存。

## 支持范围与参考

本轮支持**已安装完成**且依赖齐全的现代原版、Fabric、Forge/NeoForge 配置。新装 Forge/NeoForge 的处理器执行、任意旧式 minecraftArguments 配置、Quilt、自定义未知主类及全量加载器 Mod 诊断仍未实现。下载中心的 Forge 安装器下载不会因此被描述为完整安装能力。

只读参考 PCL `ModMinecraft.vb` 的 `PathIndie`，HMCL `DefaultLauncher.java`、`LaunchManifestNormalizer.java` 的运行目录/模块忽略列表/客户端名称处理；采用适合 Easy Craft 的原安装引用模型，没有复制其源码。

Java 版本与参数文件语义核对官方资料：[Forge 1.16 开发环境](https://docs.minecraftforge.net/en/fg-5.x/gettingstarted/)、[NeoForge 1.21.1 环境](https://docs.neoforged.net/docs/1.21.1/gettingstarted/)、[Java 参数文件与编码](https://docs.oracle.com/en/java/javase/17/docs/specs/man/java.html)。
