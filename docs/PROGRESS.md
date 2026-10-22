# 实施记录

基于随项目保存的 EasyCraft_Codex_Design_Spec.md。工作区原有 PCL/HMCL 为独立参考项目，本项目不复制其源码或素材。

## 开发顺序

- A：React / TypeScript strict / Vite / Tauri 2 骨架；构建、类型、单测、Lint、格式检查。
- B：双栏 UI、实例操作、偏好存储、键盘可达和响应布局。
- C：插件生命周期、服务契约、依赖与权限校验、回滚和清理测试。
- D：可取消的演示工作流、拖放预览、流程测试、开发文档。

## 环境

- Windows，Node 24.15.0，npm 11.12.1。
- 当前终端找不到 Rust / Cargo，因此采用规格允许的浏览器运行路径；保留完整 Tauri 工程。不自动安装系统级构建工具。
- 新项目单独初始化 Git，阶段提交只涉及 easy-craft。

## A 验证

`dev` 已启动（127.0.0.1:1420）；`build`、`typecheck`、`test`（1 项）、`lint`、`format:check` 通过。
`tauri info` 确认 WebView2 可用，缺少 MSVC/SDK、Rust/Cargo。桌面端未编译。

## B 验证

实现双栏、鼠标/键盘调整分隔栏、主题、搜索与空态、实例选择/收藏/重命名/元数据复制/添加、详情、账户占位、下载占位、设置和本地背景预览。
`build`、`typecheck`、`test`（3 项）、`lint`、`format:check` 通过；Edge 浏览器流程测试 2 项通过，验证刷新持久化、右键重命名、键盘栏宽与 800×540 布局及 Escape 弹窗关闭。
浏览器截图保存于 output/playwright（不纳入 Git）。

## C 验证

完成服务契约依赖拓扑排序、精确版本匹配、生命周期、事件校验、能力权限、扩展注册、逆序释放与加载失败回滚。三个官方插件已装配，UI 从装配层接收服务。
`build`、`typecheck`、`test`（13 项）、`lint`、`format:check`、Edge 流程（2 项）通过。覆盖缺失/循环/重复依赖、版本不兼容、注册覆盖、加载回滚、重复启停与失效上下文、清理异常不阻断后续清理。
第五项插件验收（工作流取消与页面切换）随 D 阶段真实演示任务验证。
