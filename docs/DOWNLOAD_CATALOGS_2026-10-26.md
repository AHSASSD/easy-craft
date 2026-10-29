# 下载目录联动与整行点击

## 已修改

- 选择原版时，下方保留 Minecraft 官方版本目录；选择 Forge／Fabric 时，下方改为对应加载器的官方可下载版本目录，不再展示无关的原版列表。
- 游戏版本下拉框根据加载器的真实支持目录过滤。当前游戏版本不受支持时，选择官方目录中受支持的正式版本作为回退，并重新读取加载器列表；清空前一个游戏版本的加载器选择，防止快照与 Forge 版本错配。
- Forge 读取官方 Maven 目录并按版本倒序排列，标注官方推荐；Fabric 列出官方加载器版本，默认选中官方稳定推荐版，也允许选择历史发布版本。点击列表项只选择版本，不自动下载或安装。
- 读取中、空列表、失败与重试分别显示；切换类型／游戏版本后的过期响应不会覆盖新选择，未完成加载或无效的版本不能提交。
- 资源卡片的图标、标题、描述、元数据及留白共同作为详情入口。采用覆盖卡片的真实按钮，支持键盘焦点；右侧来源按钮独立位于上层，仅打开官网，不触发详情。

Forge 仍只下载校验安装器，完整 Forge 实例安装与启动未增加。CurseForge 的有效授权限制保持原状。

## 图标来源

三个 PNG 直接取自对应官网，随程序打包，显示时不依赖外部图片请求。使用官方站点标识区分原版、Fabric 与 Forge，没有自行绘制替代图标。

| 本地文件                          | 官方资源                                                                                                    | SHA-256                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| src/assets/minecraft-official.png | https://www.minecraft.net/etc.clientlibs/minecraftnet/clientlibs/clientlib-site/resources/favicon-96x96.png | 562ccc07c94250047dba25b77388194b71c4439a9ecd249fe0d3212e3ababd37 |
| src/assets/fabric-official.png    | https://fabricmc.net/assets/logo.png                                                                        | a41878c3c4c5790cfc920eabf98d3404103a74a6f3df69d632ceb220c9ec9dc7 |
| src/assets/forge-official.png     | https://files.minecraftforge.net/static/images/apple-touch-icon.png                                         | ee51461b4dca5203d4e23d124abd0434700a4463d6022f481d27e7c0dbe0c594 |

## 目录来源

- Minecraft：[官方版本清单](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)。
- Forge：[官方 Maven 目录](https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json)及[推荐版本](https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json)。原版／Modrinth 下载域名策略没有放宽。
- Fabric：[支持的游戏版本](https://meta.fabricmc.net/v2/versions/game)及按所选游戏版本查询的稳定加载器元数据。

## 验证

前端 75 项、Rust 78 项及浏览器 14 项回归通过，类型检查、构建、ESLint 和 Clippy 通过。新增用例覆盖快照切 Forge 的回退、加载器目录互换、列表项选择、切换后清除不兼容值，以及来源按钮不触发内部详情。

桌面验收脚本 `scripts/verify-download-ui.mjs` 验证实际点击卡片底部元数据区域进入详情、官方目录与图标、Forge 版本、Fabric 版本及切回原版。截图和尺寸／数量在 `output/playwright/download-ui/`；保留此前 Forge 官方安装器下载校验与账号入口回归，不启动 Minecraft、不执行 Forge 安装器。

可运行程序：`src-tauri/target/debug/easy-craft.exe`。退出旧窗口后重新打开，确保载入新页面。
