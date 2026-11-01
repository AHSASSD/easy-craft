# 整合包安装位置、弹窗与 Forge/NeoForge 安装（2026-10-30）

## 最终行为

- 本地、在线整合包使用同一安装面板。可以用系统目录选择器更改安装位置，也可恢复默认；取消选择保留已有位置。
- 游戏内容及实例配置写入所选位置的 `instances/<实例 UUID>/game` 及其父目录。共享运行库、资源与下载缓存仍保存在启动器数据目录。位置写入实例 `storageRoot`，重启后保留。
- 成功任务消息、任务日志、实例概览均显示实际游戏目录；概览的“游戏文件夹”可直接打开。自选位置实例的回收区放在同一游戏库的 `instance-trash`。
- 在线整合包选择版本后打开安装弹窗，归档选择、名称、安装目录及确认安装集中在弹窗中。不会因预览自动安装。
- 整合包详情不再展开“声明的依赖与冲突”长列表。普通 Mod 等资源仍保留这项有用信息。“返回搜索结果”和重新打开安装面板的按钮固定在详情顶部。
- 原版下载页中的 Forge 入口现在执行完整安装；旧 `downloadForge` 接口仍保留仅下载安装器的语义。

## Pixelmon 原因与修复

真实文件：The Pixelmon Modpack 9.4.2，项目 `vwgtbO0y`、版本 `3WCE8Wj3`，归档 46,071,667 字节。官方 MRPACK 声明 Minecraft 1.21.1 / NeoForge 21.1.248。

1. 原 MRPACK 计划器只允许原版/Fabric，因此已下载的归档被降为“仅查看”；具体原因只保留在未显示的 warnings 中。现在接入 NeoForge，未支持格式的具体拒绝原因也会直接显示。
2. 实测发现 Windows `MoveFileW` 不支持原写法下的长路径，官方处理器成功后，提交运行库仍可能报“找不到路径”。公共提交函数现在转换为 Windows 扩展路径，同时保留不覆盖目标的原子语义。超过 260 字符的真实文件系统回归验证通过，同名目标和源文件均被保留。
3. 约 382 MiB 的 Pixelmon 主体 JAR 多次连接中断，但每次仍有有效下载进度；固定三次重试会提前终止。现在连续三次没有明显进展才耗尽停滞预算，另有最多 64 次尝试和总体时间预算，最终仍验证 SHA-1、SHA-512。无进度、永久 HTTP 错误和取消不会无限重试。
4. Forge 官方 SHA-1 请求也曾出现一次临时连接失败。Forge/Fabric/NeoForge 共用的校验值请求增加有限临时错误重试，404 等永久失败不重试，编码或校验值格式错误仍拒绝。

## 官方加载器安装

- MRPACK 接受单一原版、Fabric、Forge 或 NeoForge 声明，拒绝多个加载器和未支持的声明。CurseForge Forge 清单包接入处理器流程；原有 1.12.2 分支保留。
- 从官方 Maven 获取指定版本安装器和 SHA-1，在独立暂存目录执行官方客户端处理器，保留可访问的安装日志。运行库下载使用启动器的 HTTPS 来源限制、重试和 SHA-1 校验。
- 官方处理器完成后再核对生成版本配置，提交所需运行库和生成的客户端产物。已知哈希的缓存损坏时，用经过验证的文件修复缓存；不跳过坏文件制造成功。
- 启动准备复用现有 Forge/NeoForge 路径。补上 `.minecraft/runtime` 的有界 Java 查找，本机已有 Java 17/21 可自动匹配；未加入任意全盘扫描或自动下载 Java。
- 安装仍有归档大小、文件数量和路径限制。没有承诺所有历史 Forge 安装器格式、所有 NeoForge 发布版本、全部模组运行时兼容性。

## 实际桌面安装结果

| 测试对象                   | 实际来源/加载器                                 | 结果                                                  |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| The Pixelmon Modpack 9.4.2 | Modrinth MRPACK / NeoForge 21.1.248 / MC 1.21.1 | 自选目录安装成功，573 个最终文件逐一 SHA-512 核对通过 |
| Forge 1.20.1 / 47.3.22     | 原生 `native_forge_install` / 官方安装器        | 官方处理器成功，独立实例已加入隔离游戏库              |
| Adrenaline 26.5.1          | Modrinth MRPACK / Fabric / MC 1.21.1            | 自选目录安装成功，35 个最终文件逐一 SHA-512 核对通过  |

测试均使用隔离实例清单与离线测试身份；不读取个人登录凭据、不写入原有整合包与存档。共享缓存允许复用，因此这些结果不作为纯冷缓存测速。

Pixelmon 测试安装位置：

```text
E:\PCL2 code comparison\easy-craft\.native\fixtures\custom-pack-location\pixelmon-resume-fixed-20261030\instances\4fc390e1-4ae8-491c-9971-9499873950ab\game
```

Forge 最终回归实例：

```text
E:\PCL2 code comparison\easy-craft\.native\public-packs\forge-checksum-fixed-20261030\instances\82ed9e5d-057b-4675-bdf3-8deeefda07ad\game
```

它们没有登记到用户正式游戏库。完整安装、哈希核对和阶段记录在 `output/playwright/public-packs/` 下对应目录的 `results.json`。

## 启动准备与 UI 验证

- Pixelmon、Forge：读取真实已安装配置，解析所有 classpath 文件、游戏目录、启动参数及 Java，检查无未解析占位符；检查结果记录在各测试数据目录的 `launch-preparation-results.json`。
- **本轮没有启动 Minecraft。** 不能将静态准备成功写成已经进入主菜单；静态 Mod 声明的未检查项继续准确保留。
- 原生 WebView2 实测 1120×720、900×600：详情滚动到底后返回按钮仍在可见顶部；选择版本打开弹窗；真实系统目录选择及取消均通过；Esc 关闭后返回列表正常；仅预览没有创建实例。
- 截图和 UI 断言记录在 `output/playwright/pack-ui/`，脚本 `scripts/verify-pack-install-ui.mjs` 可重跑。
- Rust 回归覆盖自选位置事务发布/恢复、无关文件保留、同盘回收、位置与计划绑定、长路径及不覆盖、超过三次的有效续传、官方来源和损坏缓存修复、临时校验服务重试。
- Rust 127 项、前端 94 项、已有浏览器 E2E 14 项通过；真实处理器启动准备集成另行通过。类型检查、Clippy、ESLint、格式和桌面构建通过。构建产物为 `src-tauri/target/debug/easy-craft.exe`。

## 重跑入口

```powershell
node scripts/verify-pack-install-ui.mjs
$env:EASYCRAFT_PACK_TEST_CASES='tests/fixtures/pixelmon-pack.json'
$env:EASYCRAFT_PACK_TEST_LABEL='pixelmon-another-run'
$env:EASYCRAFT_PACK_TEST_CUSTOM_DESTINATION='1'
node scripts/verify-public-packs.mjs
```

Forge 单独安装用 `tests/fixtures/forge-install.json`，Fabric 对照用 `tests/fixtures/pack-location-fabric.json`。重复测试应使用新的 label，避免把已有实例误当成本轮新装结果。
