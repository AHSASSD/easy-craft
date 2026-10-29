# Modrinth 浏览性能改进（2026-10-26）

## 本地参考与结论

只读研究本地 PCL、HMCL，借鉴请求与缓存方式，未复制其实现代码。没有对两款启动器做同机计时，源码只能说明采用的策略，不能保证任意网络下的速度。

- PCL 2.99：`../PCL-2.99.0.0/Plain Craft Launcher 2/Modules/Base/ModNet.vb` 的 `SendRequest` 延迟初始化共享 HttpClient，使用 CacheCow HTTP 缓存，启用 GZip/Deflate 解压。
- PCL `Modules/Resource/ResourceVersion.vb` 的 `FromProjectId` 使用进程内 `ProjectFilesCache`，请求版本列表时带 `include_changelog=false`。
- PCL `Modules/Minecraft/ModDownload.vb` 的 `DlModRequest` 按用户下载源设置排列官方、镜像候选，失败后顺序回退；Modrinth 官方请求保留较长超时。
- HMCL `../HMCL/HMCL-main/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/repository/ModrinthRemoteAddonRepository.java` 使用分页搜索、过滤条件、16 并发信号量，版本列表同样省略 changelog，通过 DownloadProvider 获取候选源。
- HMCL `HMCL/src/main/java/org/jackhuang/hmcl/download/HMCLDownloadProvider.java` 包含 Modrinth API/CDN 镜像规则；`HMCLCore/.../util/io/HttpRequest.java` 能读取 gzip 响应。本轮未据此断言 HMCL 对所有请求都主动协商 gzip，或具有与 PCL 相同的版本缓存。

Easy Craft 原来已有 20 项分页、450ms 搜索防抖、`include_changelog=false`、项目介绍与版本列表并发请求，以及仅渲染展开的大版本分组。这些继续保留。发现的主要浪费是：重复访问仍下载相同元数据，浏览请求每次创建 HTTP 客户端，JSON 请求未协商压缩。

## 实施

- Modrinth 浏览共享一个 reqwest Client，复用连接池。
- `browse_cache.rs` 对完整 URL 建立进程内短期缓存：搜索 60 秒，分类、项目介绍和版本列表 300 秒；不同查询、类别、加载器、游戏版本、分页和排序互不混用。
- 相同 URL 的并发请求共享 OnceCell；HTTP、接收及 JSON 解码错误不缓存，下一次允许重试。容量限制为 32 个 URL、合计 16 MiB 序列化 JSON，按最近访问淘汰。实际 JSON 对象内存另有开销；不写入磁盘，重启重新获取。
- JSON 请求协商 gzip，使用项目已有 flate2 解压，无新依赖。压缩前后均保留 8 MiB 限制；损坏压缩包、无效 JSON、不支持的压缩格式明确失败。二进制下载不受该协商逻辑影响。
- 安装计划、依赖解析与整合包预览仍直接调用 `net::resource_json`，不读取浏览缓存；下载来源、哈希、取消和实例快照校验继续工作。
- 本轮沿用官方 API，没有默认接入第三方镜像。国内网络首次查询仍可能较慢，缓存过期和重启后的首次访问同样需要真实网络。

## 实测

通过真实 debug 桌面 EXE 的 WebView2 CDP 调用原生命令，使用隔离空游戏库，不启动 Minecraft、不登录。测试项目为 Fabric API（P7dR8mSH），Minecraft 1.21.1 / Fabric，完整列表均为 1216 个版本，IPC 响应均为 490626 字节。

| 场景                     | 改动前        | 改动后                   |
| ------------------------ | ------------- | ------------------------ |
| 同一搜索重复访问         | 1836–2129 ms  | 9–14 ms                  |
| 分类重复获取             | 1499–1782 ms  | 3–6 ms                   |
| 全版本详情重复打开       | 8017–15749 ms | 124–165 ms               |
| 全版本详情进程内首次获取 | 5356 ms       | 两轮分别为 3515、2795 ms |
| 搜索首次获取             | 2673 ms       | 两轮分别为 1358、2709 ms |

首次搜索的第二轮没有加快，说明首次网络速度有波动，不能将缓存命中的结果当作首次访问速度。另一次调试测量全版本首次请求为 4600 ms；该次 UI 脚本使用了错误的控件角色而失败，修正测试定位后完整重跑通过。

独立 curl 对同一完整版本端点比较：未压缩 1026774 字节 / 5.203 s；gzip 211788 字节 / 2.263 s，传输体积约减少 79%。这是一组网络样本，不是稳定吞吐保证。

真实 UI 在数据已缓存的情况下，点击 Fabric API 到详情出现分别为 112、93 ms。确认仍有多个 Minecraft 大版本分组、1.21 分组内 169 个版本、默认选中 1.21.1 文件，并保存截图。UI 这组数据是预热后的端到端测量，不能与首次请求混算。

记录：`output/playwright/modrinth-performance/{baseline,optimized,optimized-ui}.json`，截图 `detail-0.png`、`detail-1.png`、`search.png`。

## 验证与复现

- `node scripts/benchmark-modrinth.mjs optimized-ui`：真实应用联网计时、缓存命中低于 1 秒断言、详情与大版本分组、返回列表、无页面异常、截图；仅在联网环境使用。
- `scripts/native.ps1 -Action test`：82 项通过，6 项需联网或安装环境的集成测试默认忽略；新增覆盖缓存合并、参数隔离、过期、错误重试、容量/最近访问淘汰，HTTP gzip 协商、解码与解压上限。
- `npm test`：75 项通过；构建包含 TypeScript 检查，Rust Clippy、ESLint、Prettier 通过。
- `node scripts/verify-mod-preflight.mjs`：隔离实例中的缺失依赖、风险确认、完整依赖、实例变化、缓存篡改、损坏 JAR、真实 FerriteCore 7.0.3 在线预检/安装与磁盘 SHA-512 核对通过。确认压缩改动未破坏实际安装路径。

桌面产物：`src-tauri/target/debug/easy-craft.exe`。
