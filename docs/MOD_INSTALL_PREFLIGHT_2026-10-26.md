# Mod 安装前预检实施与实例验证

本轮按用户确认的原则实施：先展示报告，玩家可选择“仍然安装”；文件损坏、覆盖、实例变化和占用保护继续生效。未修改日常账号与游戏数据。

## 已实现

- Fabric 在线 Mod：固定来源与版本、缓存下载并校验后，结合实例已启用模组生成预检报告，确认后才写入实例。
- 本地 Mod：原生选择器、文件输入与拖入均先生成同一类缓存计划，不直接导入。
- 检查必需依赖版本、Minecraft／Fabric／Java 条件、声明的不兼容项、重复 ID／别名和可解析的内嵌模组。复用既有 Fabric 约束求解器和可验证的加载器资料。
- 发现声明问题时显示黄色问题区域，明确列出未确认范围；必须勾选“我已阅读预检问题，仍要安装”才可继续。也可以取消并自行调整。
- 提交重新检查目标快照、文件哈希及任务状态，使用既有事务与来源记录，不覆盖已有不同文件。

## 验证

| 检查                                    | 结果                                    |
| --------------------------------------- | --------------------------------------- |
| TypeScript／Vite 构建                   | 通过                                    |
| Vitest                                  | 71 项通过                               |
| Rust                                    | 75 项通过，6 项原有外部资源测试保持忽略 |
| ESLint、Clippy（-D warnings）、Rust fmt | 通过                                    |
| 浏览器端到端回归                        | 14 项通过                               |
| 实际 debug EXE + WebView2 + 隔离实例    | 通过，详情见下                          |

`scripts/verify-mod-preflight.mjs` 创建三个 Minecraft 1.21.1 / Fabric 0.16.14 隔离实例，复用已校验的加载器缓存，不使用账号凭据。合成测试 JAR 只包含元数据，没有类和入口点。验收覆盖：

1. 缺失必需依赖：真实界面显示错误、未确认按钮禁用，取消后目标无文件。
2. 明确确认：问题 Mod 实际安装并核对字节，安装后的只读诊断仍能提示依赖问题。
3. 完整依赖：识别已有依赖，正常安装且诊断无已知声明问题。
4. 声明冲突：未确认请求拒绝；确认后如果实例被外部改变，提交仍失败且没有新增 Mod。
5. 缓存篡改、损坏 JAR：拒绝提交，实例文件保留。
6. 真实 FerriteCore 7.0.3 Fabric（Modrinth 版本 sOzRw3CG）：实际在线缓存、预检、安装、磁盘 SHA-512 核对。
7. 真实在线预览／确认 UI，以及本地原生选择器（包括取消）、文件输入和拖入。

本轮验证安装与实例文件行为，未启动 Minecraft，因此不宣称实际进入世界验证了运行时兼容性。

## 产物与复现

- 程序：`src-tauri/target/debug/easy-craft.exe`（debug，无新安装包）。
- 完整隔离实例路径、各项结果和真实在线文件哈希：`output/playwright/mod-preflight/result.json`。
- 截图：同目录的 `01-missing-dependency.png`、`02-dependency-satisfied.png`、`03-installed-warning.png`、`04-online-preview.png`。

```powershell
npm test
npm run lint
npm run format:check
npm run test:e2e
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action clippy
.\scripts\native.ps1 -Action fmt
.\scripts\native.ps1 -Action build
node scripts/verify-mod-preflight.mjs
```

桌面验收依赖此前官方 Fabric 集成测试在 `.native/integration` 中保存的加载器资料、本地 Java 21 与 Edge，以及 Modrinth 网络；任一条件不满足会明确失败，不伪造报告。界面偏好在验收后恢复。

## 当前范围

目前为官方服务内置能力，支持 Fabric，未开放第三方社区插件运行时。校验器返回首个问题，其余条件在报告中标为尚未确认；未知文件不会被当作满足依赖的依据。支持有限的内嵌依赖组合，超过解析与资源上限会返回错误。

本地文件按实例要求的 Java 分析，实际 Java 留到启动流程验证；缺少可验证的加载器内置资料会列入未确认项目。在线下载仍要求能解析出来源可靠、内部一致的计划。

在线安装保留原有的必需依赖计划；本地 JAR 缺依赖时暂不自动根据 Mod ID 查找对应下载项目。升级、降级、禁用和删除旧 Mod，Forge／NeoForge 规则及全部运行时冲突诊断未在此轮实现。
