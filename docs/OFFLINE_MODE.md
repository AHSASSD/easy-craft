# V0.2 离线账户增强验证

## 行为

下载本来就无需登录。本次允许用户显式选择离线启动，输入 3–16 位 ASCII 字母、数字、下划线用户名并保存。离线身份由 `MD5("OfflinePlayer:" + username)` 按 Java UUID v3 位规则生成，不调用 Microsoft / Xbox / Minecraft 账户认证。MD5 使用现有 Windows CNG 接口，无新增依赖；它只生成兼容身份，不用于安全认证。

离线参数使用本地名字、离线 UUID、占位 accessToken `0`、userType `legacy`，不携带正版 Client ID、XUID 或凭据。Microsoft 模式继续要求有效账户并执行原认证路径；不会因认证失败自动降级离线。旧 settings.json 自动补充默认 Microsoft 模式和空离线名。

离线账户和正版账户分别展示；更名或改用正版身份会改变 UUID，影响背包、进度和宠物归属，不迁移存档。离线身份不能通过需要正版验证的服务器或 Realms 的验证。

## 本轮检查

| 检查                      | 结果                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript 与前端生产构建 | 通过                                                                                                                                 |
| Vitest                    | 25 项通过                                                                                                                            |
| Rust 普通测试             | 17 项通过；3 项集成检查默认忽略                                                                                                      |
| Edge 流程                 | 7 项通过                                                                                                                             |
| 缓存离线准备集成          | 通过；所有 HTTP 指向不可用代理，完整 1.21.1 缓存仍可校验并构造参数                                                                   |
| 实际桌面离线启动          | Debug 和 Release 均通过：测试账户 EC_OfflineTest、无微软账户、无 Client ID；真实 Java 进程输出 OpenAL initialized 后通过结束按钮回收 |
| 桌面构建与安装包生成      | Debug、Release 和 NSIS 构建通过，安装包尚未在干净系统安装验证                                                                        |

实际启动暴露并修复 Java 不识别 `\\?\` Win32 路径前缀的问题。同一 client.jar 用带前缀路径时报告 ClassNotFoundException，普通绝对路径能够加载主类。宿主现在在规范化目录后转为 Java 可用的 DOS/UNC 路径，保留原目录位置；有回归断言。

## 复现

```powershell
.\scripts\native.ps1 test
.\scripts\native.ps1 test -Integration offline
.\scripts\native.ps1 build
node scripts/smoke-native.mjs debug --launch-offline
```

离线缓存测试依赖此前安装集成测试下载的 `.native/integration` 资源。缺少时先执行 `test -Integration install`。桌面检查临时保存离线配置，完成后还原测试配置；调试端口仅用于此检查。

首次下载和损坏缓存修复需要联网；游戏自身可能尝试联网获取皮肤等信息，启动器离线模式不会屏蔽整个 Java 进程的网络。尚未验证创建世界、长时间游玩、多人连接与干净系统安装；本人 Microsoft 登录仍待用户提供自有应用和授权。
