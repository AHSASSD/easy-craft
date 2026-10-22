# 官方插件 API 1.0.0

Phase 0 仅接收由源码装配的 Plugin 对象，没有扫描插件目录、读取 JS 文件或执行 ZIP 的路径。

## 清单

每个插件必须有唯一 id、三段 version、apiVersion、requires、provides、permissions。apiVersion 目前必须是 `1.0.0`；requires/provides 的键是服务契约 ID，值是精确版本，暂不支持范围。

```ts
{
  id: 'official.themes',
  version: '0.1.0',
  apiVersion: '1.0.0',
  requires: { preferences: '1.0.0' },
  provides: { themes: '1.0.0' },
  permissions: ['services', 'themes']
}
```

## 生命周期

`setup(ctx)` 必选；`start(ctx)`、`stop(ctx)` 可选，可以返回 Promise。setup 需注册清单声明的所有服务。一个清单中的依赖不能指向自身提供的服务；未声明依赖不能 getService。为资源在创建时立即 addDisposable，不能等 start 成功后再登记。

`load(plugins)` 是批次事务；失败回滚当前批次。运行中再次 load 会拒绝，先 stop 后可重新 load。stop 保留 host.preferences，移除所有插件服务、页面、主题与事件监听。当前版本没有单插件热卸载，避免破坏仍在运行的依赖插件。

## 上下文能力

| 方法                       | 权限                     | 行为                                                 |
| -------------------------- | ------------------------ | ---------------------------------------------------- |
| getService(id)             | 声明在 requires/provides | 按类型契约读取服务，缺失时报错                       |
| registerService(id, value) | services                 | 必须在 provides，验证方法形状，禁止覆盖              |
| onEvent(name, listener)    | events                   | 自动登记取消订阅                                     |
| emitEvent(name, data)      | events                   | 校验已知事件载荷后分发                               |
| registerPage({id,title})   | pages                    | 注册可在开发者工具中检查的页面扩展元数据，停止时移除 |
| registerTheme(theme)       | themes                   | 注册内置主题定义，停止时移除                         |
| addDisposable(fn)          | 无额外权限               | 逆序释放资源；已停止上下文拒绝调用                   |

页面扩展当前是元数据注册验证，未提供第三方页面渲染 SDK。服务契约表见 src/core/contracts.ts。新增契约需同步类型表、内核方法形状校验、清单白名单和测试。

## 事件

- `instances:changed`: `{ count: number }`，非负整数。
- `launch:progress`: LaunchProgress，固定步骤/状态，percent 可选且 0–100。
- `kernel:ready`: `{ plugins: string[] }`。

事件监听器应同步、短小且自行处理业务错误；异步任务应通过服务与 AbortSignal 管理，不在事件回调中创建不受控后台任务。

## 版本与安全

服务契约版本与插件发布版本独立。API 兼容只采用精确匹配。权限是官方模块约束，不是 JS 沙箱。不要把外部源码作为 Plugin 对象载入；正式 SDK 需另行设计隔离、权限审核、签名和故障隔离。
