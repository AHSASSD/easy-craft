# 下载界面与既有功能核对

## 对话核对

已读取同工作区对话「ECL版本开发1」中有关登录、版本列表、资源搜索与图标的记录，并与现有源码核对。

设备码登录没有被删除：原流程仍按获取设备码、自动打开微软官方网页、轮询授权结果执行；失败后可重新打开网页、复制设备码或取消。该对话也明确记录，完整登录需要 Easy Craft 自有且具备 Minecraft 访问能力的公共 Client ID，真人授权验收尚未完成。此次未借用其他启动器的应用身份。

上轮 UI 把版本列表折叠后不易发现，资源行的操作区也仍占用过多高度。此次修正可见性、排版与信息密度。

## 本轮改动

- 账户面板显式展示设备码授权的三个步骤，常驻“打开 Microsoft 官方授权页”按钮。未配置 Client ID 时在主界面说明原因，保留高级配置入口。取得设备码后原有自动打开网页、复制、轮询与取消流程继续保留。
- 原版页面顶部安装区改为紧凑横向表单，在下方列表滚动时固定可见。小窗口自动换行，保留版本、加载器、名称及安装操作。
- 下方直接显示最新正式版／预览版，以及正式版、预览版、远古版分组，支持搜索。数据来自官方清单，特殊活动版本沿用官方类型；不编造独立类型。旧式远古版本仅供浏览，明确禁用其安装操作。
- 增加 `native_version_catalog` 返回真实类型与发布日期；原有 `native_versions` 继续只返回正式版供资源筛选使用。现代预览版可进入既有安装校验流程，旧式参数依然不支持；本轮没有安装或启动预览版游戏来验证其运行效果。
- Modrinth 列表压缩为紧凑行，保留真实项目图标，并显示作者／来源、筛选对应 Minecraft 版本、下载量和项目更新时间。缺失数据明确显示未提供。
- 详情页直接列出兼容版本，展示版本号、发布类型、日期、加载器、下载量和对应游戏版本；点选即切换待下载文件，随后复用原有预检、确认和安装流程。选择版本本身不会写入实例。

## 验证

- 前端 72 项、Rust 75 项、浏览器端到端 14 项通过。Rust 中 6 项原有外部资源测试维持忽略；另行执行实际桌面验收。
- TypeScript／Vite、ESLint、Clippy（-D warnings）与格式检查通过。
- `scripts/verify-download-ui.mjs` 启动实际 debug EXE，使用独立数据目录与 WebView2 配置。验证官方清单确有正式版／预览版／远古版、下方滚动后顶部保持固定、800×540 无横向溢出。
- 1120×720 首屏完整展示 4 条真实资源结果；接口元数据与实际图标均已读取，详情中实际展示 36 个兼容版本并验证切换。
- 账户面板验证官网入口和配置说明可见；单元回归仍验证获取设备码后才打开官网，以及打开失败后重试与取消。此次没有真人登录、账号授权或游戏安装。

实际尺寸、接口类别和截图保存在 `output/playwright/download-ui/verification.json` 与同目录 PNG。结果与版本数量会随上游接口变化。

## 产物

`src-tauri/target/debug/easy-craft.exe`，为本轮重新构建的 debug 程序，无新安装包。旧窗口需退出并重新打开才能载入新界面。

```powershell
npm test
npm run lint
npm run format:check
npm run test:e2e
.\scripts\native.ps1 -Action test
.\scripts\native.ps1 -Action clippy
.\scripts\native.ps1 -Action build
node scripts/verify-download-ui.mjs
```

资源字段依据 [Modrinth 搜索接口](https://docs.modrinth.com/api/operations/searchprojects/) 与 [项目版本接口](https://docs.modrinth.com/api/operations/getprojectversions/)。当前内置搜索来源仍为 Modrinth，未把 CurseForge 或 Forge 安装描述为已接通。
