# 红石生电优化安装与仅保存归档

## 复现与原因

在隔离目录通过 Easy Craft 原生安装流程安装 Modrinth 项目 `1Fv3GHYS` 的 26.2-5.8 版本（`oHZpW479`）。旧版完整复现：

`mods/emotecraft-for-MC26.2-3.4.0-b.build.166.jar：拒绝重复或大小写冲突的压缩条目`

从该整合包索引下载同一 Emotecraft 文件，核对真实中央目录：存在 `assets/emotecraft/lang/en_US.json` 与 `en_us.json` 等大小写不同的语言资源。这些路径留在 JAR 内、由 Java 按名称读取，不会分别解压到 Windows 目录。原检查器把需要解压的整合包规则用于了整颗不解压的 Mod JAR，造成误拒绝。

## 修复

- 新增仅供原样保存的 Mod JAR 使用的结构检查，保留条目数、展开大小、路径越界和符号链接检查；JAR 内名称按大小写区分。
- 整合包 ZIP/MRPACK 和其他资源的检查仍使用原有大小写冲突规则，没有全局取消检查，也没有改写 Mod 内容。
- 整合包最后检查、在线 Mod 安装预检、本地 Mod 导入和 CurseForge 模组下载均采用相同的 Mod 检查方式；安装器归档等仍走原来的严格检查。
- JAR 的整文件 SHA-1/SHA-512、元数据检查和安装事务未绕过。

## 仅下载归档

在线整合包版本弹窗增加“安装为游戏实例 / 仅下载整合包归档”。后者复用现有受限原生资源保存接口：

- 选择系统文件夹，保存原始 `.mrpack` / `.zip`；不会创建实例，也不下载索引引用的全部 Mod、游戏和加载器。
- 固定项目、版本、文件归属与哈希；下载和校验进度接入底部任务。
- 取消文件夹选择不执行保存；同名文件拒绝覆盖。
- 本地整合包导入继续沿用原有安装流程；不新增没有作用的导出入口。

MRPACK 通常是索引归档；仅保存不等于已制作出完整离线安装包。界面明确提示不会下载包内依赖。

## 验证结果

- 旧版：隔离完整安装失败，原因与用户反馈相同。日志 `output/rso-before.log`、报告 `output/playwright/public-packs/rso-before/oHZpW479-result.json`。
- 新版：同一版本完整安装成功，包括模组校验和最终发布；没有启动 Minecraft。日志 `output/rso-after.log`、报告 `output/playwright/public-packs/rso-after/oHZpW479-result.json`。
- 校验安装后的 Emotecraft 与整合包声明的 SHA-512 一致，未修改、移除或替换 Mod；证据 `output/rso-installed-integrity.json`。
- 实例仅在 `.native/public-packs/rso-after/.minecraft/versions/` 下，不修改玩家原有实例、账号或存档。测试复用了已校验缓存，不作为下载测速。
- 新增合成回归：合法大小写资源在 Mod JAR 模式通过，在需解压资源模式拒绝；路径越界与 Windows 保留路径仍拒绝。下载到 `output/emotecraft.jar` 的真实文件也单独显式运行了回归测试。
- 后端 141 项通过、19 项集成默认跳过，其中真实 Emotecraft 测试已单独运行并通过；前端 104 项、端到端 14 项通过。TypeScript、ESLint、Clippy 通过。
- 桌面端真实操作测试 `scripts/verify-pack-save-ui.mjs`：从搜索结果选择红石生电优化版本，切换为仅下载，使用系统文件夹选择器保存，核对哈希，确认实例数保持为 0；验证取消选择和同名不覆盖。
- 保存界面截图与报告：`output/playwright/pack-save/0f3b0f40-6b18-4db6-87fd-7d84f2572d7b/`。
- 程序产物：`src-tauri/target/debug/easy-craft.exe`。
