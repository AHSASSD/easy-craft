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
  const [skinMessage, setSkinMessage] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [websiteMessage, setWebsiteMessage] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  async function openOfficialWebsite() {
    setWebsiteMessage('');
    await service.openLogin();
    setWebsiteMessage('已请求系统浏览器打开微软官方授权页。');
  }
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
    if (mode === 'microsoft' && !current.account && !clientId.trim()) {
      setConfigOpen(true);
      throw new Error(
        '此开发版本尚未配置 Microsoft 登录，请在高级登录配置中填写应用 Client ID。',
      );
    }
    await service.saveSettings({
      ...current.settings,
      launchMode: mode,
      offlineName: mode === 'offline' ? name : current.settings.offlineName,
      clientId:
        mode === 'microsoft' ? clientId.trim() : current.settings.clientId,
    });
    if (mode === 'offline' || current.account) onDone();
    else {
      await service.beginLogin();
      await openOfficialWebsite();
    }
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
              <p className="hint">
                点击下方登录按钮，在浏览器中输入设备码并授权，然后返回这里。
              </p>
              {!state?.account && (
                <ol className="login-steps">
                  <li>获取设备码</li>
                  <li>微软官网输入设备码并授权</li>
                  <li>返回启动器，自动载入账户</li>
                </ol>
              )}
              {!clientId.trim() && !state?.account && (
                <p className="notice">
                  当前开发版尚未配置 Easy Craft 自有 Client
                  ID。官网入口可打开，但获取有效设备码需先完成下方高级登录配置。
                </p>
              )}
              <button
                type="button"
                onClick={() => void run(openOfficialWebsite)}
              >
                打开 Microsoft 官方授权页
              </button>
              <details
                open={configOpen}
                onToggle={(event) => setConfigOpen(event.currentTarget.open)}
              >
                <summary>高级登录配置</summary>
                <label>
                  应用 Client ID
                  <input
                    aria-label="Microsoft 应用 Client ID"
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
        <button
          onClick={() =>
            void run(async () => {
              const skin = await service.avatar();
              setSkinMessage(
                skin
                  ? '已重新读取当前账户皮肤头像。'
                  : '当前账户没有可用皮肤，显示默认头像。',
              );
            })
          }
        >
          刷新皮肤头像
        </button>
        {skinMessage && <p role="status">{skinMessage}</p>}
        {state?.account && (
          <button onClick={() => void run(service.signOut)}>
            退出正版账户
          </button>
        )}
      </fieldset>
      {websiteMessage && <p role="status">{websiteMessage}</p>}
      {state?.loginPending && (
        <div className="device-login" role="status">
          {state.loginCode ? (
            <>
              <p>在微软登录网页输入设备码：</p>
              <code className="device-code">{state.loginCode.userCode}</code>
              <p className="hint">
                1. 打开官方网页 → 2. 输入设备码并授权 → 3.
                返回启动器等待账户载入
              </p>
              <p className="hint">
                官方地址：
                {state.loginCode.verificationUri ??
                  'https://microsoft.com/link'}{' '}
                · 设备码剩余约 {Math.ceil(state.loginCode.expiresIn / 60)} 分钟
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(
                      state.loginCode!.userCode,
                    );
                    setCopyMessage('设备码已复制，请粘贴到微软官方网页。');
                  })
                }
              >
                复制设备码
              </button>
              {copyMessage && <p>{copyMessage}</p>}
              <button
                disabled={busy}
                onClick={() => void run(openOfficialWebsite)}
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
