# 直连下载、系统回收与完整进度

本轮保留已有工作区修改和玩家数据。测试在 `.native` 隔离目录中执行，没有安装到玩家游戏库，没有启动 Minecraft。

## 下载

检查后确认原实现已有 SHA-1/SHA-512 校验、六路并发、缓存复用、失败续传和停滞上限。本轮没有盲目提高并发，也未加入不明镜像。

改动：Modrinth 元数据单次请求限制为 12 秒，连接失败后的重试切换到不走代理的独立 HTTP/1 连接池，5xx 有界重试；Modrinth CDN 文件重试也使用该备用连接池，仍访问相同 HTTPS 来源并按原有哈希验证。备用连接不用于账号认证。连接池保留最多八个空闲连接，启用 TCP_NODELAY。`EASYCRAFT_NETWORK_DIRECT=1` 可用于明确禁止测试进程使用系统或环境代理。

参考了本地 PCL `Plain Craft Launcher 2/Modules/Base/ModNet.vb` 的有界重试/备用请求思路，以及 HMCL `HMCLCore/src/main/java/org/jackhuang/hmcl/task/FileDownloadTask.java` 的候选下载、完整性检查思路；没有复制其实现。保留既有断点续传测试，对代理失效与备用连接另加了可重复的本地服务测试。

当前环境使用 `curl --noproxy '*'` 读取 Modrinth API，返回 200，约 1.1 秒；无法据此复现用户所有直连网络下的故障。新增降级处理不能解决 ISP 完全阻断、失效 DNS 或所有来源不可达，也不承诺所有线路都会加速。

## 真实安装验证

通过 Easy Craft 自身的安装入口安装 Fabulously Optimized 6.5.0 / Minecraft 1.21.1。测试进程使用 `EASYCRAFT_NETWORK_DIRECT=1`，整合包内容冷缓存；基础 Minecraft 资源从已验证缓存复用，不将这部分算成重新联网下载。

- 第一次：50 个在线文件，约 42.3 MiB，完整安装 31,589 ms，成功。
- 第二次：同样冷内容缓存，31,697 ms，成功；验证待安装条目点击后在右侧显示全阶段。
- 第三次：31,694 ms，成功；最终 UI 的灰白填充与紧凑阶段列表截图已保存。
- 观测到内容下载没有发生重试或校验失败。没有旧版相同线路的对照测量，因此这些数字是本次实测速度，不是加速倍率。
- 结果：`output/playwright/public-packs/direct-nov01-final/N276l2ON-result.json`，截图：同目录 `N276l2ON-workspace-progress.png`。
- 测试实例：`.native/public-packs/direct-nov01-final/.minecraft/versions/`；其余两次也仅位于相应 `.native/public-packs/direct-nov01-*` 中，不属于玩家的正式实例。

## 版本回收

版本删除默认调用 Windows 系统回收站，成功后移出游戏库；可以取消勾选，仅移除记录。引用的本地独立 `versions/<版本>` 目录也支持回收，确认界面列出具体目录。共享的 libraries/assets、共享游戏目录和无关文件不回收；仍被其他已登记实例使用的目录/客户端文件拒绝删除。

复用宿主受限的 `IFileOperation` 回收实现，并修正 Windows Shell 对相对段和扩展路径前缀的兼容问题。系统回收失败不改用永久删除，尝试恢复游戏库记录。旧的 `instance-trash` 历史内容不自动清理。

后端测试验证了独立目录、外部引用、占用/运行中拒绝及共享文件保留；真实桌面测试 `scripts/verify-instance-management.mjs` 验证取消保留文件、系统回收、仅移除引用记录与刷新后的游戏库状态。证据在 `output/playwright/instance-management/verification.json`。

## 浏览与进度

资源浏览默认“全部版本”，与当前选中实例分开；Modrinth 和 CurseForge 搜索在该模式下不发送游戏版本筛选。玩家仍可主动筛选，安装时继续核对真实目标兼容性。当前 Mod 安装器的 Fabric 支持边界没有扩大。

整合包安装开始时发布完整阶段计划：资源解析（需要时）、基础游戏、加载器（需要时）、内容下载、文件写入、声明检查、提交。点击左侧待安装版本在右侧显示所有阶段及其进度，包括尚未开始的阶段；切回已有版本不影响下载。日志与取消入口继续保留。

左侧以灰底、从左向右变白的填充表示整体阶段进度。整体百分比按阶段等权计算，不等于字节占比或剩余耗时；内容下载阶段仍按实际已传输字节展示，任务日志保留 MiB 与校验/重试计数。失败不显示 100%，成功提交后转为正式实例。

验证：140 项后端测试通过（18 项集成默认跳过）、104 项前端测试通过、14 项端到端测试通过；类型检查、ESLint 与 Clippy 通过。日志均以 `output/download-stability-*`、`output/direct-pack-*` 保存。可运行程序：`src-tauri/target/debug/easy-craft.exe`。
