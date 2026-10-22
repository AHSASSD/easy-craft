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
