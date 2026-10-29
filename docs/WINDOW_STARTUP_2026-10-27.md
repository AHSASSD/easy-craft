# 启动全屏跳变与游戏窗口闪动修复

2026-10-27，按本聊天授权实施并实际启动测试；保留此前全部未提交修改，没有提交或推送。

## 复现与定位

用户报告游戏启动直接全屏，且游戏窗口闪白、变黑或反复出现。原 Minecraft 根目录的 `options.txt` 保存了 `fullscreen:true`。之前直接引用版本的启动流程继承该值，没有明确的启动显示策略。

用已有真实客户端、库和资源的隔离副本，把测试游戏目录的全屏项设为相同的 `true`，监测同一个 Java 进程所属 GLFW 窗口。三个版本均先显示小窗口，随后在加载途中从外框约 876×536 跳到 2560×1600 全屏。没有观测到游戏进程崩溃后反复重启。Forge 1.16 还显示早期 FML 窗口，再向正常 Minecraft 窗口交接。

这是本轮确认并修复的模式跳变路径；窗口跟踪检查创建、显隐、尺寸、全屏和最小化，不把正常加载画面颜色变化或模组的任意渲染问题一概描述为已解决。

## 修改

- 实例设置增加“启动窗口”：窗口模式（默认）、全屏模式、跟随游戏设置。每个实例独立保存，保留已有 Java、内存、版本隔离配置；旧清单没有该字段时默认窗口模式。
- 在创建 Java 游戏进程前应用窗口选择，避免先显示小窗再因读到旧设置突然切全屏。窗口模式去除元数据中显式的 `--fullscreen`；全屏模式规范为一个该参数；跟随模式保留原参数。
- 仅在确实需要变化时修改 `options.txt` 的全屏项。原字节先备份；保留其他选项、Mod 自定义行、全屏分辨率、原换行和无关数值。不枚举存档、不获取所有世界的会话锁，也不对整份音画选项作重写。
- 已经符合所选模式时不重复写文件或产生备份。窗口默认值下文件缺失时不为此建立配置。无效编码/全屏值明确报错并保留原文件；“跟随游戏设置”不改该文件。备份位于该游戏目录的 `.easycraft-backups`。
- Java 8 的旧 ModLauncher/Forge 在窗口模式下使用自身支持的 `-Dfml.earlyprogresswindow=false`，避免额外早期窗口的 GL 交接。其他加载器不套用该参数，跟随/全屏选择也不强制这个兼容策略。
- NeoForge 保留其早期图形初始化功能，没有为消除加载窗口而统一关闭 `earlyWindowControl`。其官方源码明确指出关闭该功能可能影响依赖这些图形特性的 Mod：[FMLConfig](https://raw.githubusercontent.com/neoforged/FancyModLoader/4.0/loader/src/main/java/net/neoforged/fml/loading/FMLConfig.java)、[ImmediateWindowHandler](https://raw.githubusercontent.com/neoforged/FancyModLoader/4.0/loader/src/main/java/net/neoforged/fml/loading/ImmediateWindowHandler.java)。
- 实例音画面板说明启动显示选择的优先级；跟随游戏设置时使用音画面板中的全屏值。进入游戏后仍可使用 F11。

## 真实运行对照

全部使用 `.native/launch-smoke/<uuid>/minecraft/runs/<版本>` 下的隔离游戏目录与离线测试身份，没有启动个人世界或把原目录设为运行目录。测试前仍将各自的 `fullscreen` 设为 `true`，验证由启动器真正修正，而非仅更换干净配置来绕开问题。

| 实际版本                   | 修改前可见窗口尺寸                   | 修改后可见窗口尺寸                | 修改后全屏跳变 | 可见窗口重建 |
| -------------------------- | ------------------------------------ | --------------------------------- | -------------- | ------------ |
| Minecraft 1.16.5           | 876×536 → 2560×1600                  | 始终 876×536                      | 0 次           | 0 次         |
| Forge 1.16.5 / 36.2.34     | 876×536 → 2560×1600，有 FML 早期窗口 | 始终 876×536，无独立 FML 早期窗口 | 0 次           | 0 次         |
| NeoForge 1.21.1 / 21.1.139 | 876×536 → 2560×1600                  | 始终 876×536，保留早期图形功能    | 0 次           | 0 次         |

表中是当前屏幕/DPI 下的物理外框尺寸，客户区为 854×480，不是跨设备固定分辨率承诺。日志、窗口事件和运行报告在 `output/playwright/window-display/before`、`after-final`。

复核时 GDI 桌面/窗口截图读到了白图，延长等待、窗口 DC 和 PrintWindow 也存在该现象。进一步用只附着本轮隔离 Java 进程的诊断工具取了三份线程快照：渲染线程在帧率等待与 OpenGL 绘制之间运行，没有发现 Java 级死锁。最后通过向已核对归属的测试窗口发送 F2，取得 Minecraft 自身生成的 PNG，人工查看确认三个真实版本都正常显示主菜单。**没有把初始化日志、白色 GDI 图或仅创建进程当成主菜单成功证据。**

最终游戏图像：

- `output/playwright/launch-smoke/1.16.5.png`
- `output/playwright/launch-smoke/1.16.5-forge-36.2.34.png`
- `output/playwright/launch-smoke/neoforge-21.1.139.png`

游戏内截图只写到测试目录。4,328 个所用原始客户端/库/资源文件的 SHA-256 复核一致，所有本轮测试 Java 进程已回收。没有修改原游戏目录的音画设置来制造成功。

## 回归、UI 与产物

- Rust 96 项通过、10 项默认忽略；新增全屏项最小修改、原字节备份、重复启动不写入、缺失配置、损坏配置、跟随选择、不创建世界会话锁等回归。启动参数回归覆盖三个模式以及旧 FML 参数范围。
- 前端 84 项通过，新增模式保存与其他实例覆盖项保留、非法枚举类型拒绝。
- 实际桌面依次保存全屏/跟随/窗口选择，核对原有 Java 覆盖保持不变。800×540、125% WebView 缩放下没有横向溢出，键盘可到保存按钮，放弃编辑恢复已保存选择。界面截图在 `output/playwright/window-display/ui-final`。
- 浏览器 E2E 14 项通过；类型构建、Rust fmt、Clippy、ESLint、Prettier 和 diff 空白检查通过。
- 可运行程序：`src-tauri/target/debug/easy-craft.exe`。退出旧进程并打开此版本后生效；“游戏库 → 实例设置 → 启动窗口”可以改为全屏或跟随设置。

复测脚本：`scripts/verify-local-launch.mjs`，配合 `EASYCRAFT_DISPLAY_TRACE`、`EASYCRAFT_SMOKE_FULLSCREEN=true`、`EASYCRAFT_EXPECT_WINDOWED=1` 与已有隔离测试数据目录；`scripts/watch-test-game-window.ps1` 只跟踪该测试启动器的 Java 子进程。截图助手优先使用游戏内截图，并验证目标进程及游戏目录归属。
