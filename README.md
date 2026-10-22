# Easy Craft V0.1

一个属于你的 Minecraft Java 版启动器起点。当前交付为 **Phase 0 演示版**：可运行、可交互、可验证的 UI 和官方插件内核，**不会登录、下载、安装或启动 Minecraft**。

## Windows 快速启动

需要 Node.js 22.12+ 或 24 LTS 和 npm。本机验证环境为 Node 24.15.0 / npm 11.12.1。无需 Minecraft 或 Java。

```powershell
cd 'E:\PCL2 code comparison\easy-craft'
npm ci
npm run dev
```

打开 <http://127.0.0.1:1420/>。终端保持运行；Ctrl+C 停止。开发服务只监听本机。端口占用时，先关闭旧的开发服务再启动。

## 现在可以做什么

- 双栏界面、自定义标题栏、可拖动分隔栏；焦点移到分隔栏后也可用左右方向键调整。
- 深板岩夜色 / 草方块亮色主题，本地背景图片预览（PNG/JPEG/WebP，最大 10 MB，不上传；重启需重选）。
- 搜索、最近使用或名称排序、收藏置顶、选择实例、查看详情。
- 添加、重命名、复制**演示实例资料**；复制不涉及游戏文件，删除与打开目录禁用。
- 核心偏好与实例资料本地保存；同一版本可以有不同实例 ID。
- 双击模拟启动默认关闭，可在设置启用。账户为虚构访客，下载中心明确标为后续功能。
- 设置中显式开启开发者工具后，可查看当前官方插件、服务、主题、页面注册情况。
- 三个可信官方插件：实例、主题、演示启动；支持依赖检查、精确版本兼容、权限检查、失败回滚和统一释放。
- 模拟启动：检查环境 → 准备资源 → 构造参数 → 模拟完成，包含进度、日志、取消与重试。切换页面任务继续运行，应用卸载或插件停止时取消。
- 拖入 `.zip` / `.mrpack` 查看文件名、类型与大小；每次最多预览 20 个文件，**不读取包内容、不解压、不安装**。

体验成功流程：选择“草原上的第一天”→模拟启动。体验失败流程：选择“山间工坊”（演示缺失状态）→模拟启动。失败状态只用于演示，不能据此判断真实游戏环境。

## 检查与构建

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
npm run test:e2e
npm run build
npm run preview
```

`test:e2e` 使用本机 Microsoft Edge；如未安装 Edge，需要先安装或将 playwright.config.ts 的 channel 改为已安装的浏览器。测试会自动启动开发服务，已有相同服务则复用。`preview` 预览 dist 中的生产构建。`npm run format` 修复格式。

本轮实际结果见 [docs/PROGRESS.md](docs/PROGRESS.md)。最终验证：20 项 Vitest 测试、6 项 Edge 流程测试；构建、严格类型检查、Lint 与格式检查通过。

## Tauri 桌面开发与 Windows 打包

原生工程、窗口控制、权限清单、CSP 和本地图标已配置，但**本机未验证原生编译、窗口按钮或安装包**。

环境检查发现 WebView2 已安装，Rust/Cargo 和 Microsoft C++ Build Tools / SDK 缺失。安装步骤以 [Tauri 官方 Windows 前置条件](https://v2.tauri.app/start/prerequisites/) 为准。需要 Rust stable MSVC 工具链、Microsoft C++ 桌面构建工具及 Windows SDK、WebView2。

补齐工具后在新终端执行：

```powershell
cd 'E:\PCL2 code comparison\easy-craft'
npm ci
npm run tauri -- info
npm run tauri -- dev
# 退出开发窗口后打包
npm run tauri -- build
```

首次成功构建会生成 Cargo.lock，应加入版本控制。Rust 直接依赖已经精确锁定，传递依赖当前尚未生成锁文件。NSIS 安装包预期位于 `src-tauri/target/release/bundle/nsis/`；这是配置目标，**本轮未生成安装包**。打包工具可能从官方源获取其构建组件，与 Minecraft 下载无关。

窗口尺寸统一放在 src-tauri/tauri.conf.json：初始 1120×720，最小 800×540。浏览器预览使用浏览器自身窗口，隐藏原生窗口控制按钮。

## 项目结构

```text
src/app/                 装配、顶层状态和页面组合
src/components/          标题栏、原生 HTML dialog
src/features/            演示任务面板、文件导入预览
src/core/contracts.ts    数据和服务接口
src/core/services.ts     实例、偏好、主题的基础实现
src/core/persistence/    校验与本地存储适配
src/core/plugins/        插件内核与可释放作用域
src/core/tasks/          演示服务与应用任务控制器
src/plugins/official/    三个官方插件
src/themes/             主题 token、响应式布局
src/assets/             自制立方体 SVG
src-tauri/              受限 Tauri 原生宿主
tests/                  单元、组件与浏览器流程
docs/                   架构、API、路线、执行记录与许可证
```

进一步阅读：[架构](docs/ARCHITECTURE.md)、[插件 API](docs/PLUGIN_API.md)、[路线图](docs/ROADMAP.md)、[依赖与许可证](docs/DEPENDENCIES.md)。

## 数据与边界

偏好保存在 `easycraft.preferences.v1`，实例资料保存在 `easycraft.instances.v1`。数据局限于当前浏览器配置或当前 Tauri WebView，二者不互通。非法持久化数据会提示并尝试备份到 `.invalid-backup`，备份失败则仅使用内存，不覆盖原数据。存储写入失败时提示本次更改只在当前窗口有效。

这里只保存虚构账户与演示资料，不保存账户密码、令牌或游戏存档。所有插件是打包进应用的可信代码；能力检查**不是第三方代码沙箱**，没有外部插件导入、动态执行或插件商店。

## 下一步

优先补齐原生工具链，执行 Tauri 编译和实际窗口/打包验收；之后再开始 V0.2 的正版认证、安全凭据和可信原版资源链路。V0.1 的演示服务不能用于启动真实游戏。
