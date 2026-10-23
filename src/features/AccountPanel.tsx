import { useState, useSyncExternalStore } from 'react';
import type { NativeService } from '../core/native-contracts';

export function AccountPanel({
  service,
  onDone,
}: {
  service: NativeService;
  onDone(): void;
}) {
  const {
    available,
    state,
    error: connectionError,
  } = useSyncExternalStore(service.subscribe, service.snapshot);
  const [mode, setMode] = useState(state?.settings.launchMode ?? 'offline');
  const [name, setName] = useState(state?.settings.offlineName ?? '');
  const [clientId, setClientId] = useState(state?.settings.clientId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked =
    busy || state?.task.status === 'running' || !!state?.loginPending;
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : '账户操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function useAccount() {
    const current = service.snapshot().state;
    if (!current) throw new Error('账户服务尚未连接');
    await service.saveSettings({
      ...current.settings,
      launchMode: mode,
      offlineName: mode === 'offline' ? name : current.settings.offlineName,
      clientId:
        mode === 'microsoft' ? clientId.trim() : current.settings.clientId,
    });
    if (mode === 'offline' || current.account) onDone();
    else await service.beginLogin();
  }
  return (
    <div className="account-panel">
      <p>选择本次使用的游戏账户，保存后立即显示在左下角。</p>
      {!available && (
        <p role="status">账户登录需要桌面版；浏览器预览不会创建真实账户。</p>
      )}
      {(error || connectionError) && (
        <p className="notice" role="alert">
          {error || connectionError}
        </p>
      )}
      <fieldset
        disabled={!available || !state || locked}
        className="native-fieldset"
      >
        <div className="button-row">
          <button
            aria-pressed={mode === 'microsoft'}
            onClick={() => setMode('microsoft')}
          >
            正版登录
          </button>
          <button
            aria-pressed={mode === 'offline'}
            onClick={() => setMode('offline')}
          >
            离线登录
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(useAccount);
          }}
        >
          {mode === 'offline' ? (
            <>
              <label>
                离线用户名
                <input
                  aria-label="离线用户名"
                  required
                  minLength={3}
                  maxLength={16}
                  pattern="[A-Za-z0-9_]{3,16}"
                  value={name}
                  placeholder="例如 EasyPlayer"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <p className="hint">
                本地游戏无需 Microsoft
                账户。用户名区分大小写；更名会改变玩家身份和存档归属。离线账户无法通过正版服务器验证。
              </p>
            </>
          ) : (
            <>
              <p>
                {state?.account
                  ? `已授权：${state.account.name}`
                  : '在 Microsoft 官方网页完成授权，密码不会交给启动器。'}
              </p>
              <details open={!clientId}>
                <summary>Microsoft 登录配置</summary>
                <label>
                  应用 Client ID
                  <input
                    aria-label="Microsoft 应用 Client ID"
                    required
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </label>
                <p className="hint">
                  需要 Easy Craft 自有且可访问 Minecraft 服务的公共客户端应用
                  ID。配置一次后保留；无需填写 Client Secret 或密码。
                </p>
              </details>
            </>
          )}
          <button className="primary" type="submit">
            {mode === 'offline'
              ? '使用离线账户'
              : state?.account
                ? '使用正版账户'
                : '登录 Microsoft'}
          </button>
        </form>
        {state?.settings.launchMode === 'offline' && (
          <label className="file-setting">
            为 {state.settings.offlineName} 选择皮肤头像
            <input
              aria-label="选择皮肤头像"
              type="file"
              accept="image/png"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void run(async () => {
                  if (file.size > 2 * 1024 * 1024)
                    throw new Error('皮肤须小于 2 MB');
                  const img = await createImageBitmap(file);
                  const valid =
                    img.width === 64 && [32, 64].includes(img.height);
                  img.close();
                  if (!valid) throw new Error('皮肤尺寸须为 64×64 或 64×32');
                  await service.saveAvatar(
                    Array.from(new Uint8Array(await file.arrayBuffer())),
                  );
                });
              }}
            />
            <small>
              仅改变启动器头像，不会替换离线游戏中的皮肤。正版账户头像自动读取其官方皮肤。
            </small>
          </label>
        )}
        {state?.account && (
          <button onClick={() => void run(service.signOut)}>
            退出正版账户
          </button>
        )}
      </fieldset>
      {state?.loginPending && (
        <div className="device-login" role="status">
          {state.loginCode ? (
            <>
              <p>在微软登录网页输入设备码：</p>
              <code className="device-code">{state.loginCode.userCode}</code>
              <button
                disabled={busy}
                onClick={() => void run(service.openLogin)}
              >
                打开 Microsoft 登录网页
              </button>
              <p>授权结果会自动更新，关闭弹窗后也会继续。</p>
            </>
          ) : (
            <p>正在完成账户认证…</p>
          )}
          <button disabled={busy} onClick={() => void run(service.cancelLogin)}>
            取消本次登录
          </button>
        </div>
      )}
      {state?.account &&
        state.settings.launchMode === 'microsoft' &&
        !state.loginPending && (
          <p role="status">正版账户已就绪：{state.account.name}</p>
        )}
    </div>
  );
}
