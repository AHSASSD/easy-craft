# 自动准备 Java 运行时

Client ID 由用户后续申请，本轮继续补齐 Java 自动准备。现有导航、目录按钮和布局不变。

## 行为与来源

- 实例处于自动 Java 模式时，启动前优先复用兼容的本机 Java。缺少时使用 Mojang 官方 Windows x64 运行时；手动指定实例 Java 时不替换路径、不下载替代版本。
- 官方清单支持 Java 8、16、17、21、25 的组件映射，实际下载后还检查主版本和 64 位架构。本轮实际完整下载、探测验证的是 Java 21；其他组件并非逐一完成游戏启动验收。
- 官方索引：<https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json>。
- 新模块 `src-tauri/src/java_runtime.rs` 复用现有下载校验、续传和取消逻辑，使用原始文件下载，不引入解压或其他下载源。Forge/NeoForge 安装准备也接入同一机制。
- 清单自身按官方 SHA-1 和大小验证；逐文件校验、限制总量和路径、拒绝链接与大小写冲突，所有文件完成后探测真实 java.exe。校验文件暂存在 `cache/java-runtime/<manifest SHA-1>/files`，通过后重命名到 `runtimes/java<major>-<hash>-<UUID>`。自动匹配只读取已提交运行时，不扫描该暂存缓存。
- 取消或失败不发布未完成目录；已校验和续传缓存可供下一次重试。不会修改全局 Java 或实例手动覆盖，不安装系统级 Java、不修改 PATH。
- 下载进度、取消及结果复用“任务与日志”。运行中优先展示任务进度，失败/取消后才展示诊断摘要，避免大段摘要挤占进度区。Java 自动模式的路径字段明确标为“全局 Java 候选路径”，避免将候选误认为最终选择。

## 验证

- 150 项 Rust、112 项前端、14 项 Edge 端到端通过；类型、ESLint、Clippy 和桌面构建通过。20 项后端集成默认忽略，其中本轮官方运行时集成已单独执行通过。
- `official_java_runtime_downloads_and_reuses_without_launching_game`：独立 `.native/java-runtime/<UUID>` 下载 Java 21 的 402 个文件、探测主版本/位数、自动查找复用。耗时约 45 秒，非性能承诺。
- `EASYCRAFT_RUNTIME_UI_CHECK=1` 配合 `node scripts/verify-usability-final.mjs`：给测试子进程隔离 Java 搜索相关环境，不借用开发机已有 Java；真实下载时取消，确认没有可用运行时发布，再重试完成 Java 21 安装并自动匹配复用。同时回归常规/最小窗口、明暗主题和失败诊断。
- 前端覆盖准备结果校验、取消错误和任务状态刷新；后端覆盖不安全清单、预取消不写入、不替换显式路径等。
- 最终桌面截图/报告：`output/playwright/usability-final/e2e0d59e-4496-462a-8d9d-6a39e961d1b3/`。截图分别等到 UI 显示运行中及“Java 21 已准备好”，避免将旧轮询状态误作最终结果。
- 没有启动 Minecraft，未修改个人账号、存档或正式实例；运行时安装成功不等于特定整合包已进入主菜单。

日志：`output/java-runtime-tests.log`、`java-runtime-real.log`、`java-runtime-front.log`、`java-runtime-e2e.log`、`java-runtime-clippy.log`、`java-runtime-build.log`、`java-runtime-native.log`。

程序：`src-tauri/target/debug/easy-craft.exe`。既有原布局备份保留，未提交或推送。
