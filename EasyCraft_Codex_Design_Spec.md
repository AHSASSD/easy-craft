# Easy Craft — Codex 开发设计规格（V0.1）

> 项目定位：一个简洁、可定制、渐进式呈现高级能力的 Minecraft Java 版启动器；长期采用微内核与插件式服务架构。
>
> 本文是可执行的工程需求，不是宣传方案。请 Codex 优先完成 **Phase 0：可以运行、可以交互的桌面 UI + 插件内核验证**。不要声称模拟功能已实现真实游戏启动。

## 0. Codex 执行总指令

你是 Easy Craft 项目的首席工程师。首先检查工作区与现有项目结构，保留已有代码和用户数据；如为空目录则初始化项目。先提交/输出简短实施计划，再开始编写代码。遇到不明确但非关键的问题，依据本文默认方案推进，不要频繁要求用户确认。每完成一个里程碑，执行构建、测试、格式检查，记录结果。不得假装完成未实现的功能。

**本轮必须交付：**

1. 能在 Windows 开发环境运行的桌面应用（Tauri 2 + React + TypeScript + Vite；如依赖条件不满足，先提供能在浏览器运行的 React 原型并记录阻碍）。
2. 与手绘草稿相呼应的双栏桌面 UI、可拖动分隔栏、主题切换、实例列表、账户入口、模拟启动工作流。
3. 最小可运行插件内核（服务注册、依赖检查、生命周期、事件与卸载清理），及 2–3 个官方示例插件。
4. 示例实例数据、基础自动化测试、README、开发命令、架构文档。
5. **不得**在 Phase 0 执行真实 Microsoft 登录、下载未知文件、调用非可信第三方启动器或执行任何未经用户确认的系统修改。

## 1. 目标与边界

### 1.1 目标用户

- **普通玩家**：选实例、点启动，隐藏专业术语与复杂配置。
- **模组/整合包玩家**：方便管理多个隔离实例、Mod、资源包、存档和环境状态。
- **开发者**：通过版本化 API 注册页面、资源提供者、工作流和诊断能力。

### 1.2 核心产品原则

- **简单优先**：默认首页只保留最主要的启动路径。
- **逐步展开**：高级操作出现在实例详情或开发者设置中，不强迫用户选择“新手/专家模式”。
- **插件化不是目的**：优先解决启动、环境一致性、更新失败恢复等问题。
- **数据安全**：严禁无提示地删除实例、覆盖存档、运行不可信扩展。
- **可访问性**：键盘可操作、焦点明显、对比度足够；尊重系统减少动态效果设置。
- **可维护性**：UI 不应直接操纵磁盘或进程；通过统一服务接口调用。

### 1.3 本轮非目标

- 真正登录 Microsoft / Xbox 账户。
- 真正下载安装 Minecraft、本地 Java、Forge/Fabric/NeoForge/Quilt。
- 启动真实 Minecraft 进程。
- Modrinth / CurseForge 在线集成。
- 正式的插件商店、第三方插件执行沙箱、跨设备云同步、AI 诊断。

这些在界面上可以出现“规划中”或受控占位入口，但不得提供看似已可用的假按钮。**模拟启动**必须清楚标记为“演示模式”。

## 2. 视觉与交互规范

### 2.1 总体风格

- 产品名称：**Easy Craft**。名称和图标先使用可替换的本地占位素材。
- 现代、干净、轻量；以 Minecraft 方块/地形意象做适度装饰，避免直接复制 PCL/HMCL 界面。
- 默认主题：**深板岩夜色**（暗色中性背景，青绿/草绿强调色）；另提供 **草方块亮色** 示例主题。
- 默认使用系统字体，保留未来可替换像素字体的主题入口。
- 图标统一使用一个图标库（如 Lucide），避免混用。
- 背景支持本地图片预览；Phase 0 只选择图片文件并用于本地界面显示，不上传网络。
- 组件需支持浅色/深色、悬停、按下、禁用、加载、错误和空状态。

### 2.2 桌面窗口与布局

- 初始窗口尺寸建议 1120 × 720，最小尺寸建议 800 × 540；尺寸参数集中配置。
- 自定义标题栏：左侧 LOGO + Easy Craft，右侧最小化/最大化/关闭；在 Windows 上保证拖动区域和按钮命中正确。
- 主体为**左侧实例栏 + 右侧工作区**。左侧默认宽度约 300px，允许鼠标拖动中间分隔条，限制合理最小/最大宽度。窗口变窄时可折叠左栏。
- 左栏顶部：搜索、添加实例、下载中心、设置等快捷入口（按实际状态显示）。
- 左栏中部：可滚动的实例列表，显示名称、游戏版本、加载器类型、简要状态。
- 左栏底部：账户入口 + 当前选中实例 + 显著的“启动游戏”按钮。
- 右侧默认首页：Minecraft 风格的欢迎横幅/用户自定义背景、当前实例摘要、最近活动/任务状态。不要把页面填满无意义信息。
- 右侧可以切换：**首页 / 实例详情 / 下载中心（占位） / 设置 / 开发者工具（需显式启用）**。

### 2.3 版本实例交互

- 左键单击：选中实例，并更新右侧摘要。
- 双击：提供“是否允许双击启动”的设置，默认关闭，防止误触。
- 右键：弹出菜单“查看详情、重命名、复制实例（模拟）、打开目录（需路径存在）、删除（演示模式禁用或需确认）”。
- 支持搜索实例、按名称或最近使用排序、收藏置顶。
- 列表为空时展示引导态，而不是空白页面。
- 实例概念独立于游戏版本：允许多个相同版本实例，未来其 Mod、存档和配置相互隔离。

### 2.4 交互一致性

- “启动游戏”：Phase 0 进入**明确标注的模拟工作流**，显示检查环境→准备资源→构造参数→启动完成（模拟）的分步状态与可取消操作；严禁实际启动游戏。
- 异步任务均有状态、进度（能确定时）、错误文本、重试或取消入口。
- 设置改动如主题、左栏宽度、最近选择的实例应本地持久化。
- 文件拖拽：识别 `.zip` / `.mrpack` 并显示“导入预览”；本轮不解压安装文件，只展示文件名、类型、大小及“真实导入将在后续版本实现”。防止拖拽触发浏览器默认打开导航。
- 键盘操作：Tab 导航、Enter 激活、Escape 关闭弹窗；菜单焦点处理规范。

## 3. 分层系统架构

```text
Easy Craft Desktop App
├── Presentation (React + TypeScript)
│   ├── Shell / Titlebar / Sidebar / Workspace
│   ├── Pages / Theme / Dialog / Notifications
│   └── Typed View Models
├── Application Layer
│   ├── Use Cases / Task Orchestrator
│   ├── Service Contracts
│   └── App State / Preferences
├── Plugin Kernel (TypeScript, Phase 0)
│   ├── Context + Service Registry
│   ├── Plugin Lifecycle + Dependency Graph
│   ├── Event Bus + Disposable Cleanup
│   └── Capability-aware Extension Registry
├── Official Plugins
│   ├── Instances Plugin
│   ├── Themes Plugin
│   └── Demo Launch Plugin
└── Trusted Native Host (Tauri + Rust)
    ├── Restricted File Dialog / Persistence
    └── Future: secure credentials, downloads, process launch
```

**运行时限制：** Tauri WebView 不等于 Node.js 运行环境；不得假设 `node:fs`、`child_process` 等 API 在前端可用。Phase 0 插件应是项目打包时纳入的可信官方 TypeScript 模块。**不要加载或执行任意外部 JS/ZIP 插件**。未来第三方插件应通过独立进程或受约束执行模型与 Native Host 交互，并落实权限审查。

## 4. 插件内核最小设计

### 4.1 核心抽象

- `PluginManifest`: 唯一 `id`、`version`、`apiVersion`、`requires`、`provides`、`permissions`。
- `PluginContext`: 只暴露安全受控的 `getService`、`registerService`、`onEvent`、`emitEvent`、`registerPage`、`registerTheme`、`addDisposable` 等必要能力。
- `Plugin`: `setup(ctx)`，可选 `start(ctx)` / `stop(ctx)`；运行和清理顺序固定。
- `ServiceRegistry`: 按契约 ID 查找；禁止无提示覆盖已注册服务；缺少依赖时返回可读错误。
- `PluginManager`: 解析依赖拓扑顺序，检测循环依赖与版本不兼容，加载失败应回滚已经登记的资源。
- `DisposableScope`: 统一管理事件监听、注册页面、定时/订阅等副作用，在插件关闭时逆序释放。

### 4.2 Phase 0 的示例服务契约

```ts
interface InstanceService {
  list(): Promise<GameInstance[]>;
  getById(id: string): Promise<GameInstance | null>;
  select(id: string): Promise<void>;
}

interface LaunchService {
  simulateLaunch(
    instanceId: string,
    signal?: AbortSignal,
  ): AsyncIterable<LaunchProgress>;
}

interface ThemeService {
  listThemes(): ThemeDefinition[];
  activateTheme(id: string): void;
}
```

以上是指导接口；具体命名可适当优化，但应保持**插件依赖服务契约而不是依赖具体插件实现**。

### 4.3 官方示例插件

- `official.instances`: 提供模拟实例、选择与更新通知。
- `official.themes`: 主题清单、激活、偏好持久化。
- `official.demo-launch`: 以可取消异步任务展示模拟启动步骤。

### 4.4 必须验证的插件场景

1. 三个官方插件能够按依赖顺序启动。
2. 依赖缺失/循环依赖/重复服务注册有明确错误信息。
3. 启停插件后不会残留重复事件监听或页面注册。
4. UI 通过服务契约读取数据，而不是直接引用插件实现模块。
5. 模拟启动可取消，不会因页面切换产生无主任务或内存泄漏。

## 5. 基础数据模型

```ts
type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';

type GameInstance = {
  id: string; // UUID
  name: string;
  minecraftVersion: string;
  loader: LoaderKind;
  loaderVersion?: string;
  gameDirectory?: string;
  favorite: boolean;
  lastPlayedAt?: string; // ISO 8601
  status: 'ready' | 'missing' | 'installing' | 'broken';
};

type LaunchProgress = {
  step: 'validate' | 'prepare' | 'arguments' | 'finish';
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  message: string;
  percent?: number;
};
```

- 实例的 `id` 不等于 Minecraft 版本号；允许版本重复。
- 偏好与样例数据可先本地 JSON / 浏览器存储；真实数据库的选择留待后续阶段。不得在持久化层直接耦合组件。
- 账户敏感信息不进入普通配置文件；Phase 0 只展示虚构账户占位信息。

## 6. 推荐目录结构

```text
easy-craft/
├── src/
│   ├── app/                # 应用装配 / 路由 / 组合
│   ├── components/         # 通用 UI 组件
│   ├── features/           # 页面级功能
│   ├── core/
│   │   ├── contracts/      # 类型与服务接口
│   │   ├── plugins/        # PluginManager / Context / Disposable
│   │   ├── tasks/          # 工作流抽象
│   │   └── persistence/    # 存储适配器
│   ├── plugins/official/   # 内置示例插件
│   ├── themes/             # 主题 token 与样式
│   └── assets/             # 本地可替换资源
├── src-tauri/              # Tauri/Rust 原生端
├── tests/                  # 单元与组件测试
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PLUGIN_API.md
│   └── ROADMAP.md
└── README.md
```

## 7. 实施步骤与验收标准

### Milestone A — 项目骨架

- 初始化 React + TypeScript + Vite + Tauri 2（优先使用稳定版本）。
- 配置 ESLint、Prettier、TypeScript strict、Vitest（可选 React Testing Library）。
- 提供 `dev`、`build`、`test`、`lint` 等明确脚本。
- **验收**：应用可启动，构建、类型检查通过。

### Milestone B — 手绘草稿 UI 还原

- 完成标题栏、可拖动左侧实例栏、主页、实例详情、设置页。
- 完成深/浅主题、选中实例、右键菜单、搜索、空状态。
- 实现有视觉反馈的响应式布局，最小宽度下可正常操作。
- **验收**：所有主要交互可操作，刷新/重启后保留核心偏好。

### Milestone C — 插件内核验证

- 落地最小插件生命周期、服务注册、事件和副作用回收机制。
- 接入三个官方插件，让 UI 通过服务消费数据。
- **验收**：上述五个插件测试场景全部通过。

### Milestone D — 演示工作流与测试

- 真实可取消的模拟启动任务，分步进度、日志、失败态演示。
- `.zip` / `.mrpack` 文件拖放预览；不安装、不解压。
- 补充用户使用流程测试和开发文档。
- **验收**：从选择实例到模拟启动结束全流程连贯；README 可让另一位开发者在 Windows 上复现。

## 8. 工程质量要求

- TypeScript 开启 `strict`，避免 `any` 滥用；所有跨层消息有类型定义和运行时校验。
- 错误信息面向用户，调试详情单独记录；日志不得泄露未来的账户令牌。
- 异步操作使用可取消机制；组件卸载时正确清理订阅。
- 不把测试结果写成通过，除非实际运行过相应命令。
- 不为了视觉效果引入侵权游戏素材；使用自行制作/授权资源或可替换占位资源。
- 不将修改注册表、管理员提权或其他系统级操作作为默认行为。
- 如使用第三方库，记录其版本与许可证，锁定依赖版本并提供锁文件。
- 使用 Git 分阶段提交，清晰记录每个阶段的实际实现范围。

## 9. 后续路线（不在本轮实现）

### V0.2 — 真正的 Minecraft 原版启动

- Microsoft 正版账户 OAuth 流程与安全凭据存储。
- Minecraft 版本清单获取、资源下载、哈希校验、缓存、断点重试。
- Java 运行时管理、启动参数构造、游戏进程启动与日志。
- 独立实例目录、错误处理、启动过程诊断。

### V0.3 — 模组与整合包生态

- Fabric / Forge / NeoForge / Quilt 安装支持（分步实现）。
- Modrinth `.mrpack` 和常见 ZIP 整合包识别与安全导入。
- Mod 依赖解析、安装前变更预览、实例复制。
- 文件路径穿越防护、内容哈希校验与来源可信性检查。

### V0.4 — 可靠性优势

- 环境快照、备份恢复、更新事务与失败回滚。
- 崩溃日志解析和确定性诊断规则。
- 实例清单导出、跨设备迁移。

### V0.5 — 用户意图工作流

- 根据用户提供的可信服务器环境清单建立客户端实例。
- 自动检查依赖与变更，让用户确认后执行。
- 允许多个官方服务组合为统一任务。

### V1.0 — 开放插件 SDK

- 版本化契约、权限清单、受控执行环境、开发者文档。
- 第三方插件独立分发与签名/审核策略。
- API 兼容性检测、故障隔离、插件更新与回退。

## 10. 本次完成时 Codex 必须报告

1. 已实现功能清单（区分真实能力与模拟能力）。
2. 新增/修改的核心目录及关键文件。
3. `dev` / `build` / `test` / `lint` 实际执行情况。
4. Windows 下启动和打包的具体命令。
5. 未解决问题及下一步最小任务。

**首要成功标准：不依赖任何 Minecraft 安装，用户可以运行 Easy Craft，体验完整双栏 UI、实例选择、主题切换、插件驱动的模拟启动，并能看到可验证的插件生命周期测试。**
