# 架构

## V0.2 离线账户增强

NativeSettings 增加 launchMode / offlineName；Rust 使用强类型枚举和旧配置默认值。NativeWorkspace 保存模式，实例列表显示实际使用的已保存身份，NativeService 验证新字段。Host 的启动路径在显式离线模式使用本地 Profile，不请求账户认证；Microsoft 模式仍使用 access 刷新/校验，二者不自动回退。游戏资源校验、参数数组、任务取消和进程回收复用同一实现。离线身份不进入正版 account 字段，不改动加密账户文件。

Host 将规范化后的 Win32 路径转换为 Java 可读的普通绝对路径；缓存完整时资源准备无需网络。具体测试与限制见 [离线账户验证](OFFLINE_MODE.md)。

## V0.2 当前增量

保留下文 V0.1 分层与演示实现，增加 official.vanilla → NativeService → 受限 Tauri 命令 → Rust Host。UI 通过 src/core/native-contracts.ts 的 DTO 与服务访问真实功能，不持有令牌、不直接操纵磁盘/进程。

- host.rs：原生任务所有权、实例提交、配置、游戏子进程与受限日志。
- auth.rs：Microsoft 设备码、Xbox/XSTS/Minecraft 交换、所有权/档案、刷新与 Windows DPAPI。
- net.rs：官方域名、证书校验、禁止跨域重定向、哈希下载、取消、临时文件续传和重试。
- minecraft.rs：官方元数据、依赖/资源计划、平台规则、参数数组、受限 DLL 提取与 Java 版本检测。
- model.rs：安全路径、原子保存、公共 DTO 与日志脱敏。

真实任务和游戏进程由 Rust Host 持有，切换 React 页面不终止任务。桥接服务停用只回收前端轮询；窗口退出时由宿主结束其管理的游戏进程。数据独立于 V0.1 localStorage，只有成功安装的实例才写入原生清单。

下文描述的是 V0.1 演示层；其中“宿主仅创建窗口”与“没有真实账户/下载/进程”只适用于 V0.1，不代表当前 V0.2。当前认证与进程代码已实现，真人账户端到端验收仍待完成。

## 运行链路

main.tsx → bootstrap.ts → PluginManager.load → 官方插件注册服务 → App 接收 Services → UI 调用服务接口。

- Presentation：React 的 Shell、标题栏、实例栏和页面；Modal 使用 HTML dialog 处理焦点、Tab 和 Escape。背景与几何地形为本地素材，没有外部图片请求。
- Application：App 管理当前页面、搜索、弹窗；createLaunchTask 管理任务快照、日志、取消和重试。页面切换不创建新任务控制器，App 卸载才 dispose。
- Contracts：GameInstance、Preferences、LaunchProgress、InstanceService、ThemeService、LaunchService 等接口构成跨层边界，UI 不导入官方插件实现。
- Persistence：createStore 接收 StorageAdapter；读取、修改时校验数据。localStorage 是当前适配器，后续可以替换宿主存储；组件不直接调用 localStorage。
- Kernel：服务注册表、按契约依赖的拓扑排序、生命周期、事件、页面/主题注册和 DisposableScope。
- Official：三个编译期装配的可信模块；实例服务的数据变更会发出实例事件，主题服务与主题注册表对应，演示服务通过异步迭代器产生进度。
- Host：Tauri Rust 入口只创建窗口；不提供文件系统、Shell、下载、进程或凭据命令。浏览器通过标准文件选择/拖放接口获取预览，Tauri 禁用原生文件拖放拦截以复用 DOM 预览。

## 插件与服务依赖

```text
host.preferences@1.0.0
  ├─ official.instances → instances@1.0.0
  │    └─ official.demo-launch → launch@1.0.0
  └─ official.themes → themes@1.0.0
```

装配刻意把 demo-launch 放在 instances 前，内核必须通过服务依赖而非数组位置排序。主题与实例没有相互依赖。

## 生命周期和失败

完整校验图后逐个执行 setup → 检查声明服务已登记 → start。当前插件在 setup 前进入回滚列表，因此部分 setup 失败也能释放已登记资源。任何失败使本次 load 全部回滚。停止按插件启动顺序逆序执行 stop → DisposableScope.close；作用域内资源也逆序回收。某个 stop/dispose 抛错不跳过其他清理，最终汇总错误。

上下文在作用域关闭后失效。服务不允许覆盖；缺依赖、重复、环、版本不兼容、权限不足有可读错误。事件载荷、服务方法形状、实例、偏好和启动进度在边界校验。当前只支持完全相等的三段版本，避免引入未需要的 semver 解析器。

## 任务所有权

演示服务为每次迭代创建 AbortController，取消会回收延时计时器和外部信号监听。App 持有一个 createLaunchTask，它同时最多运行一个模拟任务，并消费 async iterable；失败、取消时结束迭代。插件释放作用域停止演示服务、取消所有计时器，停止后的服务拒绝新任务，也不会向已释放的上下文发送事件。

四步进度只代表演示时间，绝不代表真实 Java 检查、下载、参数可用性或 Minecraft 进程状态。missing/broken/installing 实例均走失败演示分支。

## 安全与限制

- UI 不操作磁盘和系统进程。生产 CSP 仅开放本地内容、图片 blob 和 Tauri IPC；开发 CSP 额外允许本机 Vite/HMR。
- 仅主窗口具有窗口控制权限。未安装文件、Shell、HTTP 等 Tauri 插件。
- 文件预览只查看元数据，不加载 ZIP、JS 或任意扩展代码；背景仅浏览器解码且不上传。
- 存储没有真实账户令牌，不涉及游戏数据删除或覆盖。
- 能力限制用于可信插件的开发期约束，不能隔离恶意 JS；第三方扩展需要后续独立的执行/权限模型。
- 没有游戏版本联网查询、真实登录、离线账户启动或下载。浏览器可运行；原生宿主因缺工具链仍待实测。

## 验证映射

tests/kernel.test.ts 验证依赖顺序、错误、回滚、事件与页面清理；tests/launch.test.ts 验证进度、失败、重试、取消及插件停止无计时器残留；services.test.ts 验证持久化和非法数据；smoke.test.ts 验证插件装配后的真实组件；tests/e2e 验证用户流程、页面切换、拖放、主题/选择刷新持久化及最小窗口。
