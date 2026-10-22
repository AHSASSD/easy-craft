# Windows 工作区工具链

无需完整 Visual Studio。IDE 可继续使用 CLion、PyCharm 或其他编辑器；实际构建由项目脚本调用便携 Rust/MSVC/SDK。IDE 与编译工具不是同一个东西。

## 已准备的位置

根目录：`E:\PCL2 code comparison\build-tools\easycraft`。

| 目录                           | 工具                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| cargo / rustup                 | Rust stable 1.99.1、Cargo、rustfmt、Clippy；x86_64-pc-windows-msvc |
| msvc/VC/Tools/MSVC/14.44.35207 | x64 编译器、链接器、头文件、CRT 与 OneCore 导入库；cl 19.44.35229  |
| microsoft.windows.sdk.cpp      | 官方 NuGet Windows SDK 头文件、rc.exe，SDK 10.0.28000.0            |
| microsoft.windows.sdk.cpp.x64  | 官方 NuGet Windows SDK x64 UM/UCRT 库；包版本 10.0.28000.2705      |
| java21                         | Temurin 21.0.12.1+1 JRE x64，适用于 Minecraft 1.21.1               |
| java25                         | Temurin 25.0.4.1+1 JRE x64，供需要 Java 25 的版本选择              |
| tmp / packages                 | 工作区内的临时目录与下载包                                         |

原生构建输出位于项目 src-tauri/target；Tauri 的 NSIS/WiX 工具缓存配置为 target/.tauri，不作为启动器运行时依赖分发。

## 来源与校验

- Rustup 来自 static.rust-lang.org；初始化程序使用官方 SHA-256 校验，Rustup 自身校验工具链组件。
- MSVC 来自微软 Visual Studio release channel 清单中的官方 VSIX 包，逐包校验清单 SHA-256，只解压所需组件。
- Windows SDK 来自 api.nuget.org 的 Microsoft.Windows.SDK.CPP / .x64 官方包。
- Java 来自 Eclipse Adoptium API 指向的 Temurin 官方发布，下载后校验 API 提供的 SHA-256。
- WebView2 已在此 Windows 安装中存在，未重新安装。

普通用户环境不能直接完成管理员级 Visual Studio 静默安装；本次通过官方组件解压完成编译，不要求提权，也未修改全局 PATH、JAVA_HOME、默认 Java 或注册表。

## 使用

在 CLion/PyCharm 的 PowerShell 终端或普通 PowerShell 中，从 easy-craft 运行：

```powershell
.\scripts\native.ps1 dev
.\scripts\native.ps1 build
.\scripts\native.ps1 bundle
.\scripts\native.ps1 test
.\scripts\native.ps1 clippy
```

脚本检测工具路径、设置当前进程的 LIB/INCLUDE、Rust 目录、Java 和 TEMP，然后调用现有 npm/Tauri/Cargo 命令。dev 检测已有 1420 端口服务并复用，避免同一 Vite 服务重复启动。

新机器应参考 [Tauri 官方 Windows 前置条件](https://v2.tauri.app/start/prerequisites/) 准备工具。如果改为正常安装的 MSVC，不必沿用本机便携路径，可以在对应开发者终端直接运行 npm run tauri -- dev/build。

当前工具目录是本机开发环境；分发应用只需要生成的程序或安装包，不需要将编译器、SDK、Cargo 缓存一起打包。
