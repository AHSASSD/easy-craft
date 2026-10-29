# Easy Craft UI 改造交付记录

日期：2026-10-26。按用户安排于北京时间凌晨 03:00 开始执行。
工作区：E:\PCL2 code comparison\easy-craft。

## 已交付

- 石墨灰与青绿的默认深色主题，以及沿用同一排版的浅色主题。自定义强调色继续调整文字对比度。
- 64px 主导航：游戏库、下载、扩展，设置固定在底部。实例搜索移至列表上方，保留可调侧栏与底部账号。
- 空库专用安装／导入引导；有实例时展示紧凑封面、启动按钮、实例概览、存档列表、环境摘要与快捷入口。
- 存档列表使用实际读取的数据。由于当前存档接口没有最近游玩时间，标题采用“我的世界”，没有编造最近记录或缩略图。
- 下载筛选缩为工具栏，原版完整版本列表折叠展示。1120×720 原生窗口中安装按钮位于首屏内，版本与加载器控件保持对齐。
- 设置标题与生效说明按分类分别显示，修复重复标题；Microsoft 登录保留单一主流程，Client ID 收进高级配置。
- 扩展页面显示内核实际已载入的五个官方模块，提供经典双栏／紧凑工作区切换和恢复默认栏宽。社区目录明确显示尚未开放。
- 官方默认布局参数位于 src/plugins/official/layout.json，导航顺序、概览区块顺序与排版参数从同一文件读取。
- 实例标签支持方向键、Home／End 与清楚的键盘焦点；长名称有截断和完整名称提示。

## 启动预检

新增只读 native_mod_check 与 NativeService.modCheck(id)，复用 Fabric 安装校验器和可验证的加载器内置模组信息。
选中实例及相关状态变化时更新报告；点击启动时再次检查。
依赖声明不匹配时显示黄色提示，报告提供“仍然启动”、重新检查、查找依赖模组和日志入口。
诊断结论不作为额外启动禁令，宿主原有的账号、Java、进程与任务保护继续工作。

当前校验器只返回首个问题，报告明确列出其余未确认范围。未知 JAR、未验证的加载器资料和运行时问题不会伪装成全面通过。
Java 展示的是实例要求与配置状态，实际版本仍由启动流程验证。

自动生成、确认并执行补装依赖计划尚未实现，UI 不提供假一键修复按钮。
完整 Forge／NeoForge 规则、所有运行时冲突诊断、持续文件监听、第三方插件执行与社区商店仍属后续工程。

## 验证结果

| 检查                                | 结果                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| npm run build                       | TypeScript 与 Vite 生产构建通过                                       |
| npm test                            | 69 项通过                                                             |
| npm run lint                        | 通过，无警告                                                          |
| npm run format:check                | 通过                                                                  |
| scripts/native.ps1 -Action test     | 72 项通过，6 项需要外部资源的集成测试按原配置跳过                     |
| scripts/native.ps1 -Action clippy   | 通过，采用 -D warnings                                                |
| npm run test:e2e                    | 14 项通过，覆盖导航、空状态、筛选、深浅色、自定义强调色、弹窗与窄窗口 |
| node scripts/verify-ui-redesign.mjs | 实际 debug EXE 验收通过                                               |

桌面验收使用新建的隔离目录与明确标记的合成样例，覆盖空库、各下载分类、设置、扩展、账号弹窗、含存档的实例、缺失依赖、长名称和 800×540 窗口。
预检样例确实经过原生 JAR 校验，验证“仍然启动”保持可用；未点击该按钮启动游戏。
验收程序不安装游戏、不进行账号授权；不以真实游戏启动成功作为本轮验收结论。
界面偏好在验收结束后恢复。隔离数据目录记录在 output/playwright/ui-redesign/verification.json。

## 构建产物与截图

可运行的桌面程序：

[E:\PCL2 code comparison\easy-craft\src-tauri\target\debug\easy-craft.exe](../src-tauri/target/debug/easy-craft.exe)

该产物为 debug 构建，不包含新安装程序。

- [实际程序：深色实例页（验收样例）](../output/playwright/ui-redesign/07-instance-dark-fixture.png)
- [实际程序：启动检查（验收样例）](../output/playwright/ui-redesign/08-preflight-fixture.png)
- [实际程序：空游戏库](../output/playwright/ui-redesign/01-empty-dark.png)
- [实际程序：原版安装](../output/playwright/ui-redesign/02-install.png)
- [实际程序：扩展管理](../output/playwright/ui-redesign/04-extensions.png)
- [实际程序：800×540（验收样例）](../output/playwright/ui-redesign/10-minimum-fixture.png)
- [实际程序：浅色实例页（验收样例）](../output/playwright/ui-redesign/11-instance-light-fixture.png)

## 复现

在工作区运行：

```powershell
npm run build
npm test
npm run lint
npm run test:e2e
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action build
node scripts/verify-ui-redesign.mjs
```

桌面验收脚本依赖本地 Edge、已构建的 debug EXE，以及原生单元测试生成的合成文件。
它单独创建 .native/ui-redesign/<UUID>，并保留截图与检查结果，便于回查。

## 地景素材来源

src/assets/landscape-dusk.png 使用内置 imagegen 工具生成并保存到项目。原有 SVG 仍保留，新增图片用于官方默认实例封面与背景预览。

最终生成提示词：

> Use case: stylized-concept. Asset type: original landscape background for the compact instance cover of the user's Minecraft Java desktop launcher Easy Craft. Generate a beautiful high fidelity Minecraft-inspired voxel landscape ONLY, no UI, no text, no logos or lettering. Very wide panoramic composition about 3:1, ideal 1536x512. Blocky grass terraces, pine forest, calm small lake, distant snow-capped stepped mountains, warm peach sunset at far upper right, cool slate blue dusk sky. Every terrain and tree element visibly constructed from cubes; carefully composed game-like voxel render with softly lit block materials and restrained atmospheric depth, no realistic rounded terrain. Camera looking across the lake toward mountains. Left third is a quieter dark forest slope with open sky and low detail, so a UI overlay could place white text there; center-right contains the scenic mountains and reflected light. Palette charcoal, pine green, teal-gray water, restrained gold and peach highlights. Crisp beautifully shaded voxel shapes, tasteful and restful, no oversaturated greens, no bloom, no dreamy blur, no neon. Landscape should be legible when cropped to a 190px-tall desktop instance cover. No characters, no structures, no watermarks. Output one wide scenic image, not a screenshot or a design board.
