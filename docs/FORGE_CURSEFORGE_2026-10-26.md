# Forge、CurseForge 与资源浏览调整

## 当前完成程度

| 能力                                                               | 状态                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| 资源搜索栏滚动固定、来源按钮等宽、图标／标题进入详情               | 实际桌面验收通过                         |
| 详情隐藏筛选栏，按 Minecraft 大版本折叠资源版本                    | 实际跨版本接口与选择验证通过             |
| 应用内 Forge 推荐／最新版本查询、官方安装器下载与 SHA-1 校验       | 实际下载通过                             |
| Forge 客户端补丁处理、实例生成与启动                               | 未实现，下载入口明确说明                 |
| CurseForge Fabric Mod 搜索、详情、必需依赖计划、缓存校验与安装预检 | 代码接入，元数据与桥接回归通过           |
| CurseForge 真实授权 API 与公网 Mod 安装                            | 当前缺少有效 API Key，未验收，不宣称成功 |

## 界面

资源搜索条件位于同一个 sticky 容器内，滚动列表时保持在内容区域顶部。结果行的项目图标、标题可用鼠标或键盘进入详情；右侧只保留固定 104px 宽的 Modrinth／CurseForge 官网按钮。

进入详情隐藏搜索条件，返回后恢复。Modrinth 详情不再只查询原筛选版本，而是读取来源提供的跨游戏版本文件；按 1.21、1.20、26.3 等 Minecraft 系列分组，展开后列出资源版本及准确兼容游戏版本。选择版本会清空旧安装计划，安装时继续按实际目标实例验证，不能因同属 1.21 系列就跳过 1.21.1／1.21.11 的精确适配检查。

CurseForge 当前仅在模组分类提供，限定 Fabric。其他资源仍使用 Modrinth。未知数据、缺少授权和作者未允许第三方下载均显示真实状态。

## Forge 实测

实际 debug EXE 从官方 promotions 元数据读取 1.21.1 推荐版本 52.1.20，再读取该安装器的官方 SHA-1 与声明大小。下载至隔离数据目录 `downloads/forge/forge-1.21.1-52.1.20-installer.jar`，最终文件 9,089,841 字节，SHA-1：

`e8dad3b52d88cc33badf3597b9f5a502e53e89e4`

初次验收暴露了共用下载器对无声明大小文件的 8 MiB 限制。Forge 现在读取官方 HEAD 的 Content-Length 原始响应头，限制在 64 MiB 内，再将精确大小交给已有续传、大小及 SHA-1 校验器。不能使用 HEAD 空响应体的长度代替文件声明大小。修复后复用了真实中断的 8 MiB 临时文件，完成剩余下载并核对哈希；新增大小头回归检查。原有 Modrinth 与基础资源来源策略未放宽。

此流程只保存并验证安装器，没有运行任何 Java 安装器、处理 processors、修改外部 Minecraft 目录或发布 Forge 实例。任务栏支持取消，日志保留文件路径。

## CurseForge 接入边界

Rust 读取 `EASYCRAFT_CURSEFORGE_API_KEY`。启动时将密钥捕获到原生进程内存，并从本进程环境移除，避免后续 WebView／Java 子进程继承；敏感请求头不会序列化到 UI，源码、普通偏好和日志均不保存密钥。修改密钥后需要重启应用。

设置方式：在你自己的启动终端中安全设置该进程环境变量，再启动 EXE；不要把密钥发到聊天、写进仓库或前端配置。尚未配置时，点击 CurseForge 会显示原因，Modrinth 仍可使用。

安装流程检查 Minecraft 游戏 ID、Mod 类别、项目／文件归属、Fabric 与准确游戏版本、文件大小、平台 SHA-1、官方 CDN、第三方下载许可和必需依赖。仅使用 API 明确返回的下载地址；未提供下载 URL 或拒绝第三方分发时转为说明，不推测 CDN 地址。CDN 请求不携带 API Key。

文件先缓存，计算本地 SHA-512 固定预览，再结合实例已启用模组执行既有预检。确认仍使用实例快照、缓存哈希、事务和不覆盖保护。来源记录使用 `curseforge<项目ID>`／`curseforge<文件ID>` 标识，不冒充 Modrinth ID。声明问题沿用玩家明确确认后“仍然安装”；损坏文件或目标变化仍拒绝。

当前限制：最多解析 64 个依赖项目、1 GiB 总大小；详情最多读取 1000 个 CurseForge 文件。可选依赖不自动安装，平台不兼容关系与全部运行时冲突未完整求解，详情保留作者声明供核对。Forge Mod 元数据检查和 Forge 实例安装仍未接入。由于没有有效密钥，本轮不能证明真实 CurseForge 文件安装端到端成功。

## 验证与产物

- 前端 74 项通过，覆盖详情隐藏搜索、跨大版本展开、选择版本清空旧计划、源身份保留及缺少密钥错误。
- Rust 78 项通过，6 项原有外部资源用例保持忽略；新增 CurseForge 文件归属／加载器／SHA-1、CDN 隔离以及 Forge 大小头检查。
- 浏览器 14 项端到端回归通过；类型检查、构建、ESLint、Clippy 与格式检查通过。
- `scripts/verify-download-ui.mjs` 验证真实滚动固定、来源按钮等宽、图标进入详情、多个 Minecraft 大版本、无密钥错误和真实 Forge 下载。数据目录与尺寸记录在 `output/playwright/download-ui/verification.json`。
- 可运行程序：`src-tauri/target/debug/easy-craft.exe`，debug 构建。退出旧窗口后重新打开。
- 截图：同目录 `07-resources-scrolled.png`、`04-resource-versions.png`、`08-curseforge-unconfigured.png`、`09-forge-download.png`。

复现命令：

```powershell
npm test
npm run test:e2e
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action clippy
.\scripts\native.ps1 -Action build
node scripts/verify-download-ui.mjs
```

桌面脚本明确以未配置 CurseForge 密钥的环境验收当前受限状态；下载网络较慢时允许等待与断点续传。不启动 Minecraft、不授权账户、不执行 Forge 安装器。可以通过 `EASYCRAFT_DOWNLOAD_TEST_DATA` 复用该脚本自己创建的 `.native/download-ui/<UUID>` 目录，其它路径被拒绝。

来源：[Forge 官方下载](https://files.minecraftforge.net/net/minecraftforge/forge/index_1.21.1.html)、[CurseForge 官方 API](https://docs.curseforge.com/rest-api/)、[Modrinth 项目版本接口](https://docs.modrinth.com/api/operations/getprojectversions/)。
