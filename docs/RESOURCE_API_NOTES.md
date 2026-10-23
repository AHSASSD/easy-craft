# Modrinth 资源接口实现笔记

核验日期：2026-10-24。只读取首方文档与生产 API 的小型 JSON，没有下载、解压或运行资源文件。以下是实现建议，不代表功能已经接入。

## 可直接使用的接口

基址采用 `https://api.modrinth.com/v2`。官方文档仍提供这套生产接口；本次无令牌实测搜索、版本列表及固定版本详情成功，不需要让用户先登录 Modrinth。不要因旧文章提到实验 v3 就迁移本轮实现。[API 总览](https://docs.modrinth.com/api/)

| 用途         | 方法与相对路径                                                                                          | 实现要点                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 搜索         | `GET /search?query=...&facets=...&offset=0&limit=20&index=relevance`                                    | facets 是 JSON 字符串，经 URL 编码；同一个子数组内 OR，不同子数组之间 AND。      |
| 项目介绍     | `GET /project/{id-or-slug}`                                                                             | 展示描述与项目链接；不能只用项目级兼容信息决定安装版本。                         |
| 兼容版本     | `GET /project/{id-or-slug}/version?game_versions=["1.21.1"]&loaders=["fabric"]&include_changelog=false` | 真正的数组参数也须 JSON 编码；列表通常无需携带所有版本 changelog。               |
| 固定版本详情 | `GET /version/{version-id}`                                                                             | 安装计划固定版本 ID，再取文件、依赖、环境并重新验证；不能仅凭前端提交 URL 下载。 |
| 标签         | `GET /tag/loader`、`GET /tag/category`、`GET /tag/game_version`                                         | loader 返回 `supported_project_types`，分类和加载器不要当成同一套固定枚举。      |

接口依据：[搜索](https://docs.modrinth.com/api/operations/searchprojects/)、[版本列表](https://docs.modrinth.com/api/operations/getprojectversions/)、[版本详情](https://docs.modrinth.com/api/operations/getversion/)、[项目详情](https://docs.modrinth.com/api/operations/getproject/)。标签结构本次通过 [生产 loader JSON](https://api.modrinth.com/v2/tag/loader) 核验。客户端带可识别 User-Agent，分页、缓存、防抖，遇 429 根据服务响应退避；本次未成功取得限流响应头，因此不要把具体额度写死为已核实事实。

## 分类过滤：必须匹配实际版本格式

以下全部分类均在生产 `/v2/search` 与 `versions:1.21.1` 联合过滤实测返回非空结果。

| Easy Craft 类别 | 搜索 facets                                                        | 版本 loader / 安装位置建议                                                                             |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Mod             | `[["project_type:mod"],["versions:1.21.1"],["categories:fabric"]]` | 版本 `fabric`；实例 `mods`。                                                                           |
| 资源包          | `[["project_type:resourcepack"],["versions:1.21.1"]]`              | 版本 `minecraft`，不能加 Fabric 条件；实例 `resourcepacks`。下载成功不等于已在游戏中启用。             |
| 光影包          | `[["project_type:shader"],["versions:1.21.1"]]`                    | 版本按 Iris/OptiFine 等匹配，不能一律 `fabric`；实例 `shaderpacks`。未安装对应加载组件时不能承诺生效。 |
| 数据包          | `[["project_type:datapack"],["versions:1.21.1"]]`                  | 版本 `datapack`；明确选中世界后进入 `saves/<world>/datapacks`，并检测世界占用。不能放进 `mods`。       |
| 整合包          | `[["project_type:modpack"],["versions:1.21.1"]]`                   | 由具体 `.mrpack` 内容确定游戏/加载器与文件，创建独立实例；不能把压缩包放进 `mods` 就算安装。           |

**关键实测边界：** 数据包搜索结果可以返回 `project_type:mod` 的多形态项目。例如 [Veinminer 搜索](https://api.modrinth.com/v2/search?query=veinminer&limit=1&facets=%5B%5B%22project_type%3Adatapack%22%5D%5D) 及 [其数据包版本列表](https://api.modrinth.com/v2/project/veinminer/version?game_versions=%5B%221.21.1%22%5D&loaders=%5B%22datapack%22%5D&include_changelog=false)；实测版本 `8cEJouzY` 的 loaders 为 `datapack`，版本号 `1.2.4`。所以不能严格要求「搜索命中返回的 project_type 必须等于选中类别」，但选文件前必须验证版本格式。该项目仅用于证明分类边界，不是本轮首选安装测试对象。[搜索分类说明](https://docs.modrinth.com/api/operations/searchprojects/)

## 安装计划、校验和依赖

固定版本至少保存 `project_id`、`id`、`version_number`、`game_versions`、`loaders`、`version_type`、`environment`、`dependencies` 与选中文件的 `filename`、`url`、`primary`、`size`、`hashes.sha512` / `hashes.sha1`。文件类型字段可能为空。一个版本可以含多个文件，应选择明确的主文件或让用户选择，不能下载所有 JAR。下载写临时文件，验证实际字节数及强散列后再落入受管理目录；同名不同 hash 不静默覆盖。[版本文件定义](https://docs.modrinth.com/api/operations/getversion/)

依赖的 `version_id` 与 `project_id` 都可能为 null。`required` 必须进入预览并满足；固定 version_id 则按固定版本解析；只有 project_id 时按目标游戏版本与 loader 再找兼容版本，不能随意拿项目最新。`optional` 用户选择；`embedded` 不重复安装；`incompatible` 与已安装清单及本次计划比较。只有文件名而缺少可解析身份、找不到兼容版本或解析冲突时，停止安装并解释原因。项目聚合依赖列表不能替代所选版本的依赖。[版本依赖定义](https://docs.modrinth.com/api/operations/getprojectversions/)

这些 API 字段不足以证明所有加载器最低版本、Java 要求、Mod 间运行时冲突或图形驱动兼容；`dependencies: []` 也不代表无需 Minecraft/Fabric。首轮可在不执行 JAR 的情况下读取其元数据进一步核对，但不能声称已经通过游戏运行验证。安装计划限制深度与节点数、检测循环、跨版本冲突；路径拒绝穿越、绝对路径、Windows 保留名及重解析点。HTTPS 下载允许来源应由原生后端约束，并检查重定向目标。这些属于 Easy Craft 实现要求，非 API 提供的安全保证。

## 环境字段已发生变化

当前版本详情返回 `environment` 字符串，项目与搜索是环境数组；搜索文档将 `client_side` / `server_side` 标为 deprecated。`unknown` 不能伪装成已知兼容；优先展示版本环境，兼容旧响应可保留旧字段。[当前搜索字段](https://docs.modrinth.com/api/operations/searchprojects/)、[当前版本字段](https://docs.modrinth.com/api/operations/getversion/)

`server_only` 可以用于单人内置服务器，而 `dedicated_server_only` 仅适用独立服务器；`client_and_server` 表示双方需要。不能简单屏蔽所有带 server 的资源，或将「已装到客户端」说成能在任意服务器使用。2025-08-28 官方旧公告说当时仅在 v3 提供新字段，但本次 **2026-10-24 v2 实测已经返回**，因此以当前端点和文档为准。[官方环境解释与历史时间点](https://modrinth.com/news/article/new-environments/)

## 两个轻量真实测试候选

所有数值来自下列固定版本 JSON，核验时尚未下载对应文件；测试前仍需重取元数据，避免把记录当可信下载凭据。

### 首选 Mod：FerriteCore

- 项目 `uXXizFIs`，slug `ferrite-core`；版本 `sOzRw3CG`，`7.0.3-fabric`。
- `game_versions=["1.21.1"]`，`loaders=["fabric"]`，`environment="client_or_server"`，API `dependencies=[]`。
- 主文件 `ferritecore-7.0.3-fabric.jar`，123450 字节。
- SHA-1：`a8a6a34fcda177da2828cedef44e0e538cf78aad`。
- SHA-512：`3ad31620fac4ff44327dc7dedbe162b2d978f3f246dc16255a6e400ce9592a0d326fe36a626f3c1bf30a11f813093cbb4dcc107af039cff724d0cdf648541fdf`。
- [固定版本 JSON](https://api.modrinth.com/v2/version/sOzRw3CG)，[项目发布页](https://modrinth.com/mod/ferrite-core/version/sOzRw3CG)。适合先测搜索→预览→下载→校验→本地管理；本笔记没有证明与当前 Fabric Loader 0.16.14 的实际启动兼容。

### 不执行代码的资源包候选：Default Dark Mode

- 项目 `6SLU7tS5`；版本 `S7URnfmp`，`2025.5.0-1.20.2`。名字虽带 1.20.2，但版本 `game_versions` 明确含 **1.21.1**。
- `loaders=["minecraft"]`，`environment="unknown"`，`dependencies=[]`。
- 主文件 `Default-Dark-Mode-1.20.2+-2025.5.0.zip`，748843 字节。
- SHA-1：`176424b313f5cc70cdcf37f4cf55af3bab95dc50`。
- SHA-512：`f13e861a306df9bf752026f5e4f8b52a84065657c6dd4a90c41d19cbd1f72304f55d5968daf228f3d364fc076db909dece26c0bc3e454ae8d74d78e447f7a0e7`。
- [固定版本 JSON](https://api.modrinth.com/v2/version/S7URnfmp)，[项目发布页](https://modrinth.com/resourcepack/default-dark-mode/version/S7URnfmp)。适合测 resourcepack 使用 `minecraft` loader 的正确过滤及 ZIP 原样落盘；没有人工验收游戏内材质效果。

附：Mod Menu 11.0.5（`6lgOkclV`）不是最省事的首测对象：本次 [固定版本 JSON](https://api.modrinth.com/v2/version/6lgOkclV) 有两项 required 项目依赖 `eXts2L7r`、`P7dR8mSH`，且未固定 version_id。可以以后用来测递归依赖，但不能在尚未完成依赖解析时只下载其主 JAR 并报告安装完成。

未检查：下载二进制与实际游戏效果；`.mrpack` 最新格式规范旧地址返回 404，本笔记不以其为依据设计完整整合包安装器。
