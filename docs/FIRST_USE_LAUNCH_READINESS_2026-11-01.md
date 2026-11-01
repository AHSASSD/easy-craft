# 首次使用与启动条件

本轮继续落实首次使用方面的建议。保留当前导航、布局和目录按钮；未扩展实例复制、整合包更新或插件执行环境。

## 实现

- 主启动按钮在缺少账号或离线名称无效时打开现有账号面板，避免只显示无法操作的禁用按钮。运行任务、登录中或浏览器预览仍遵守原互斥限制。
- 账号就绪后先检查实例实际使用的 Java。自动模式与真实启动共用选择逻辑；显式指定路径时不擅自回退其他运行时。检查不启动游戏、不下载、不保存 Java 覆盖，也不创建游戏任务。
- Java 失败在原启动检查弹窗显示具体原因与“打开实例设置”入口。保留用户继续启动的选择，后端仍会重新验证真实条件。
- 新增 `native_instance_java`，前端同步接口并校验响应结构。
- `EASYCRAFT_MICROSOFT_CLIENT_ID` 支持构建时嵌入自有应用公开 GUID；构建时检查格式，修改变量会触发重新编译。新配置和旧配置的空 ID 采用打包值；已有非空配置不覆盖。不使用其他启动器的 ID，不保存 Client Secret。

尚未提供 Easy Craft 实际应用 ID，也未进行本人 Microsoft 登录验收。该改动提供发行配置能力，不能代替应用注册、权限配置或真人授权。本轮也没有实现 Java 自动下载，电脑没有兼容 Java 时仍需准备可信运行时。

## 验证

- 后端 148 项通过，19 项集成默认忽略；新增检查覆盖未知实例、无效显式 Java、不创建游戏任务及实例清单未被改写。
- 前端 111 项、Edge 14 项通过；类型、ESLint、Clippy 和桌面构建通过。
- 桌面复现：`$env:EASYCRAFT_FIRST_USE_CHECK = '1'; node scripts/verify-usability-final.mjs`。
- 独立数据目录完成主启动按钮打开账号、保存合成离线身份、无效显式 Java 检查、设置跳转；同时回归明暗主题、常规/最小窗口与诊断复制。
- 截图检查后将 Java 错误区改为纵向排版，重新构建并复核。
- 本轮未启动 Minecraft，未使用个人账号或存档。独立空数据目录不是全新 Windows 或无 Java 系统，不能视为完整干净系统验收。

日志：`output/first-use-rust-tests.log`、`first-use-front.log`、`first-use-e2e.log`、`first-use-clippy.log`、`first-use-build.log`、`first-use-native.log`。

最终桌面截图：`output/playwright/usability-final/d54b7c19-8168-4d24-bb21-48045eed3f15/`。

程序：`src-tauri/target/debug/easy-craft.exe`。原布局备份未改动；未提交或推送。
