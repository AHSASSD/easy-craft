# Forge 与 CurseForge 探测记录

2026-10-29 当前进度：已支持 1.12.2 / Forge CurseForge 整合包安装，水星迫降启动问题及修复见 [真实启动记录](MERCURY_LAUNCH_FIX_2026-10-29.md)。以下段落保留原日期的历史状态。

2026-10-26 更新：应用内已接入 Forge 官方安装器下载与校验（完整 Forge 实例安装／启动仍未实现）；CurseForge Fabric Mod 查询、依赖计划和安装预检代码已接入，但缺少有效 API Key，真实公网安装未验收。当前状态与测试见 [本轮实施记录](FORGE_CURSEFORGE_2026-10-26.md)。以下为 2026-10-25 的历史探测结果。

日期：2026-10-25。使用工作区独立 `.native/source-probe`，未修改日常实例、账户或世界。复现：`node scripts/probe-launcher-sources.mjs`；每次会重新探测并更新该目录下 report.json，不保证未来网络返回相同。

## Forge

- 官方 promotions_slim.json 返回 Minecraft 1.21.1 推荐版本 **52.1.20**。
- 从 Forge 官方 Maven 下载 `forge-1.21.1-52.1.20-installer.jar`，大小 **9,089,841 字节**。同时读取官方 `.sha1`，本地 SHA-1 与其一致：`e8dad3b52d88cc33badf3597b9f5a502e53e89e4`。
- 保存位置：`.native/source-probe/forge-1.21.1-52.1.20-installer.jar`。ZIP 完整性检查通过；只检查归档内容，没有执行安装器。
- 安装器 install_profile.json 中有 **7 个 processors、21 项安装依赖**；version.json 使用 `net.minecraftforge.bootstrap.ForgeBootstrap`，继承 `1.21.1`。这是本次所下载版本的观察结果，不泛化为全部 Forge 版本的格式。
- **下载探测成功；应用内完整安装与启动尚未接入。** 当前正式安装器仍支持原版/Fabric。Forge 需要单独适配客户端处理步骤、补丁及生成文件、依赖/哈希、继承配置与启动参数，并完成事务提交、取消恢复和真实启动验证。不能把 Forge JAR 直接当 Fabric profile 或普通 Mod 安装。
- 探测脚本使用固定官方 URL，不放宽应用现有基础资源域名策略，也不将未安装的 Forge 加入实例清单。

来源：[Forge 官方下载](https://files.minecraftforge.net/net/minecraftforge/forge/index_1.21.1.html)、[官方推荐版本元数据](https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json)。

## CurseForge

- 本次程序 GET `https://www.curseforge.com/minecraft/mc-mods` 返回 **HTTP 403**。
- 未带 API Key 的 `https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=sodium&pageSize=1` 也返回 **HTTP 403**。
- 后续使用用户提供的临时密钥进行内存中测试：搜索 Sodium、pageSize=3，仍返回 **HTTP 403**，未获得项目列表。此结果不足以判定密钥是否无效、权限是否未开通或请求是否受网络限制；没有把密钥写入代码、配置、日志或提交。
- 官网程序请求被拒绝不代表用户用正常浏览器访问一定失败；本次没有通过浏览器完成网站访问验收。也不能只凭 HTTP 403 判定唯一原因是缺密钥。
- [官方 API 文档](https://docs.curseforge.com/rest-api/)要求请求携带 `x-api-key`。下一步应用内接入需申请自己的 API 访问资格/密钥，按平台条件处理资源和下载权限；不借用 PCL/HMCL 的密钥，不绕过网站访问控制，不展示假搜索结果。
- 当前应用内社区搜索、项目图标和资源安装来源仍是 Modrinth，CurseForge API 尚未接入。后续开始正式接入前提前说明本机密钥配置方式；密钥不放聊天、前端、源码或普通偏好文件。本轮 UI 和原版/Fabric 工作无需等待此授权。
