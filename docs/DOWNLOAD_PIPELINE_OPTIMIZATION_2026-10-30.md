# 下载流程优化与同包对照测试

## 依据与取舍

只读参考本地 PCL 2.99 的 `Modules/Base/ModNet.vb`（线程上限、接收量、超时/重试）与 HMCL 的 `task/FileDownloadTask.java`、`task/FetchTask.java`、`modpack/modrinth/ModrinthInstallTask.java`（校验缓存、候选来源、可恢复失败与任务分层）。未复制其下载器实现，也未修改参考目录。

Easy Craft 保持自己的流程：**下载与校验 → 事务暂存 → 实例入库**。网络并发与实例写入分开，进度区分接收字节、校验文件、缓存命中与重试，不把已收到文件等同于已成功安装。

## 改动

- MRPACK 文件预取最多并发 6 个，大文件优先排队。同一内容哈希只占一个下载任务，拒绝同一 SHA-512 的矛盾 SHA-1/大小声明。用户未选择的可选文件不排队。
- 网络文件全部通过校验后，串行写入实例事务，继续检查逐文件 SHA-512、快照、归档 CRC、原子发布与回滚。不会并发修改事务清单。
- 大文件与整合包归档显示真实 MiB 接收量、校验文件数、已复用文件数及重试次数。宿主进度合并到约 250ms 更新一次，沿用前端轮询；不因每个数据块重绘界面。
- 哈希检查转入阻塞工作线程，减少异步下载线程等待；流写入增加 256KiB 缓冲。仍完整校验 SHA-1，不能只按大小信任缓存。
- 永久 HTTP 错误（例如 404）立即报告，不再盲重试三遍。408、429、5xx、连接或流中断可重试，最多三次尝试；采用退避，尊重数字秒数的 Retry-After，上限 30 秒。
- 等响应最多 30 秒，正文连续 20 秒无数据则恢复重试；对持续传输的大文件给出最长 15 分钟窗口，避免原先统一 90 秒截止中断正常的慢速下载。
- 续传遇到 200（服务器忽略 Range）从头覆盖临时文件，遇到无效/过期续传范围重新开始。校验失败清空损坏临时文件并重试，最终失败不提交文件。
- 修正已确认安装在基础资源准备超过预览 10 分钟期限后失败的问题：过期预览仍不能新开任务；已由 Host 校验并消费的安装计划继续完成。成员选择与文件边界在暂存前仍检查。回归测试通过模拟计划时龄复现，无需等待十分钟。

未接入未知镜像或外部来源，也没有改变 NeoForge MRPACK 新装等加载器的支持范围。HTTP 断点是否可用取决于来源，忽略 Range 时会安全重下。

## 性能对照

前后均使用同一发布版本、相同归档 SHA-512 与逐项内容哈希；复用相同基础游戏缓存，不预置整合包归档和内容缓存。两组按相同顺序在独立目录执行真实 EXE 在线安装。

| 样本 | 前：整次安装 | 后：整次安装 | 前：内容下载及暂存 | 后：内容下载及暂存 |
| --- | ---: | ---: | ---: | ---: |
| Adrenaline 26.5.1 / 1.21.1 | 37.1 秒 | 28.8 秒 | 16.2 秒 | 13.2 秒 |
| Fabric Create Mod + More 0.1.1 / 1.20.1 | 49.0 秒 | 35.7 秒 | 26.3 秒 | 22.3 秒 |

这是单轮真实网络观测，不是固定提速承诺；CDN、系统文件缓存和约 1 秒采样误差都会影响结果。没有把首次缺少大量基础资源的耗时与之后的暖缓存耗时直接当成优化收益。原始对照为 `output/playwright/public-packs/download-comparison.json`。

## 可靠性与实际界面验证

- 更新后再次在线安装 Adrenaline、Simply Optimized、Additive、Fabric Create Mod + More，四项成功；全部安装内容逐文件 SHA-512 复核。样本覆盖 Minecraft 1.20.1、1.21.1、1.21.11。
- 真实任务窗口能显示 MiB、字节进度、缓存/重试计数和可点击的取消按钮，保存桌面截图。
- 从真实窗口在下载中点击取消：没有半成品实例进入游戏库，保留 6 个下载片段；重新读取同一发布版本并安装成功，最终所有内容哈希一致。此测试证明取消后可恢复安装；不把保留片段本身当成服务器必然支持续传的证据。
- 本地受控 HTTP 回归覆盖：损坏响应重下并通过校验、404 仅一次请求、有效 206 续传、200 忽略 Range、416 失效恢复、取消保留片段、不发布损坏文件、离线缓存命中回调。整合包回归覆盖缓存复用、内容去重、可选文件排除、矛盾声明拒绝与长任务预览时限。
- Rust 117 项、前端 93 项、浏览器 E2E 14 项通过；类型检查、ESLint、Clippy 与构建通过。本轮未启动 Minecraft、登录账号或写入正式游戏实例。

结果目录：

- `output/playwright/public-packs/download-before-20261030/`
- `output/playwright/public-packs/download-after-20261030/`
- `output/playwright/public-packs/download-matrix-after-20261030/`
- `output/playwright/public-packs/download-cancel-20261030/`

测试驱动 `scripts/verify-public-packs.mjs` 支持 `EASYCRAFT_PACK_TEST_COLD_CONTENT=1`（不预置包缓存）、`EASYCRAFT_PACK_TEST_CACHE_SOURCE`（项目内基础缓存目录）、`EASYCRAFT_PACK_TEST_CAPTURE_PROGRESS=1`、`EASYCRAFT_PACK_TEST_CANCEL_DOWNLOAD=1`。取消验证使用单独标签和样本，耗时不计入上述对照。

运行产物：`src-tauri/target/debug/easy-craft.exe`。
