# 水星迫降启动失败：启动器根因与验证

## 已确认的根因

用户的游戏日志在进入主类时失败：`NoClassDefFoundError: org/lwjgl/opengl/OpenGLException`。原版 1.12.2 清单包含同一个 LWJGL Maven 模块的 Windows/Linux 与 macOS 版本，分别带操作系统规则。旧合并器仅按 Maven 模块去重，先把 Windows 的 2.9.4 行覆盖为 macOS 的 2.9.2 行，之后 Windows 启动准备又跳过了该 macOS 行。结果是图形库没有进入 classpath，部分 native 库也未保留。

修复位于 `src-tauri/src/local_launch.rs`：合并前先按当前平台规则筛选，再执行父子版本的模块替换。这是正常安装和本地继承版本共用的代码，重新安装会生成正确配置。对于已由旧代码安装的 1.12.2 Forge 实例，读取启动快照后，使用同一数据目录内按文件名 SHA-1 核验的官方原版元数据在内存中重建依赖；原快照校验不放宽，不要求用户重新下载整合包，也不移动或删除 Mod。

截图中的四条依赖警告是另一处启动器问题：1.12.2 使用旧 Forge 规则，EntityCulling、GeckoLib JAR 里为新版本附带的 `mods.toml` 不应被套用到旧 Forge。已按实例版本分开元数据解析和缓存上下文。旧版仅解析 `mcmod.info` 的身份与重复 ID；没有读取的 `@Mod` 注解、版本范围和运行时依赖明确标为未检查。无告警不表示完整依赖检查通过。

上述错误有启动器源代码与真实运行日志证据，不能把原来的缺类异常解释成整合包缺少前置模组。对比直接 Java 运行使用同一份隔离游戏文件，成功完成 Forge 135 个模组的加载；非致命的模组日志不等于启动失败。

## 回归与实际运行

- `os_alternatives_do_not_replace_windows_lwjgl` 锁定同名、不同系统规则的合并问题；已有 Forge/NeoForge 继承替换测试继续通过。
- `legacy_forge_does_not_read_modern_toml_from_multi_version_jars` 验证旧版解析不会采纳 JAR 中不适用的现代 TOML。
- Rust 107 项、前端 91 项通过；Clippy、ESLint、类型检查及桌面构建通过。真实运行测试另见下方证据。
- `scripts/verify-mercury-launch.mjs` 使用隔离副本、Java 8、测试离线身份，不打开世界、不读取账号文件。验证旧安装快照自动恢复、无上述四条错误、真实游戏加载及窗口截图。
- `scripts/verify-mercury-pack.mjs` 增加工作区内已校验缓存的可选复用；实际安装依然经过系统文件选择、清单解析、文件校验、事务发布，不复制实例目录。新装回归不写人工恢复记录。

证据：`.native/mercury-launch-smoke.log`、`.native/mercury-reinstall-fixed.log`、`output/playwright/launch-smoke/mercury/`、`output/playwright/mercury-reinstall/`。测试驱动会清空隔离目录的旧日志，避免把上一次的加载完成信号误当作本次启动完成。个人游戏、存档和账号不参与修改。

已安装实例经 Easy Craft 启动后，实际截图确认进入水星迫降主菜单。新装回归已核对生成的配置包含 Windows LWJGL 2.9.4，不再包含覆盖它的 macOS 2.9.2 条目。外部主动结束的测试进程不作为整合包崩溃证据；新装首次启动单独复测。

最终新装实例 `04e78958-dc8d-401e-8ade-1ef05ce307ae` 经真实安装流程完成（107 个清单资源、802 个内容文件），再由 Easy Craft 启动进入主菜单，日志确认 Forge 成功加载 135 个模组。截图为 `output/playwright/launch-smoke/mercury/menu.png`；旧安装恢复的截图另存为 `existing-install-menu.png`。两次仅验证主菜单，未验证存档游玩、多人联机或每个 Mod 的游戏内功能。新装测试复用了逐项验证的文件缓存，实例及配置仍由安装流程重新生成。

## 发布范围

本轮按用户要求上传当前工作区的启动器源码、主题资源、脚本、文档和测试。`.gitignore` 排除游戏目录、账号文件、缓存、测试输出、构建产物与依赖。继续使用既有 `origin`，不强推、不替换远程。推送前扫描暂存区中的凭据特征和异常大文件。
