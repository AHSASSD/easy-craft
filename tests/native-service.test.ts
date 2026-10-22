import { afterEach, expect, test, vi } from 'vitest';
import type { invoke } from '@tauri-apps/api/core';
import {
  createNativeService,
  validNativeState,
} from '../src/app/native-service';
import type { NativeState } from '../src/core/native-contracts';
const state = (): NativeState => ({
  dataRoot: 'E:/EasyCraft/data',
  settings: {
    clientId: '',
    javaPath: 'E:/java/bin/java.exe',
    memoryMb: 2048,
    launchMode: 'microsoft',
    offlineName: '',
  },
  account: null,
  instances: [],
  task: {
    status: 'idle',
    phase: '',
    message: '',
    completed: 0,
    total: 0,
    logs: [],
    pid: null,
  },
  loginPending: false,
  loginCode: null,
});
afterEach(() => vi.useRealTimers());
test('offline settings require an explicit valid local identity and keep online account separate', () => {
  const current = state();
  current.settings.launchMode = 'offline';
  expect(validNativeState(current)).toBe(false);
  current.settings.offlineName = 'EasyPlayer';
  expect(validNativeState(current)).toBe(true);
  expect(current.account).toBeNull();
  current.settings.offlineName = '../x';
  expect(validNativeState(current)).toBe(false);
  expect(
    validNativeState({
      ...state(),
      settings: { ...state().settings, launchMode: 'unknown' },
    }),
  ).toBe(false);
});
test('browser cannot invoke native or pretend a real operation succeeded', async () => {
  const call = vi.fn();
  const service = createNativeService(false, call as typeof invoke);
  await expect(service.install('1.21.1', '世界')).rejects.toThrow('需要桌面版');
  await expect(service.launch('id')).rejects.toThrow('需要桌面版');
  expect(call).not.toHaveBeenCalled();
  service.stop();
});
test('native state is runtime validated and invalid payload is not published', async () => {
  expect(validNativeState(state())).toBe(true);
  expect(validNativeState({ ...state(), settings: { memoryMb: 0 } })).toBe(
    false,
  );
  const call = vi.fn(async () => ({ access_token: 'invalid response' }));
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  expect(service.snapshot().state).toBeNull();
  expect(service.snapshot().error).toContain('格式无效');
  service.stop();
});
test('native polling owns task snapshots across page lifetime and stops cleanly', async () => {
  vi.useFakeTimers();
  const current = state();
  current.task.status = 'running';
  const call = vi.fn(async () => current);
  const service = createNativeService(true, call as typeof invoke);
  const notify = vi.fn();
  service.subscribe(notify);
  await service.refresh();
  expect(service.snapshot().state?.task.status).toBe('running');
  expect(vi.getTimerCount()).toBe(1);
  service.stop();
  const count = notify.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1400);
  expect(notify).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
test('device authorization is polled at application scope and refreshed without sending tokens to UI', async () => {
  const current = state();
  current.loginPending = true;
  current.loginCode = { userCode: 'ABCD1234', interval: 5, expiresIn: 900 };
  const call = vi.fn(async (command: string) => {
    if (command === 'native_login_poll') {
      current.account = { id: '0'.repeat(32), name: 'Player', xuid: '123' };
      current.loginPending = false;
      current.loginCode = null;
      return true;
    }
    return structuredClone(current);
  });
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  expect(service.snapshot().state?.account?.name).toBe('Player');
  expect(call).toHaveBeenCalledWith('native_login_poll', undefined);
  service.stop();
});
