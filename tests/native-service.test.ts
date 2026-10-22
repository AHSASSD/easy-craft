// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { AccountPanel } from '../src/features/AccountPanel';
import { MemoryPanel } from '../src/features/MemoryPanel';
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
    memoryMode: 'manual',
    optimizeMemory: false,
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
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
test('system memory trimming is optional and requires its explicit confirmation', async () => {
  const current = state();
  const memory = {
    totalMb: 8192,
    availableMb: 6144,
    recommendedMb: 4096,
    reserveMb: 1024,
  };
  const call = vi.fn(async (command: string) =>
    command === 'native_status' ? structuredClone(current) : memory,
  );
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  render(createElement(MemoryPanel, { service }));
  expect(
    (
      screen.getByRole('checkbox', {
        name: '启动前内存整理',
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '系统内存整理' }));
  expect(
    call.mock.calls.some(([command]) => command === 'native_memory_optimize'),
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认整理系统工作集' }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('native_memory_optimize', {
      system: true,
    }),
  );
  await screen.findByText(
    '已请求系统整理可访问进程工作集，当前可用内存已刷新。',
  );
  service.stop();
});
test('avatar account panel saves offline identity directly without a login request', async () => {
  const current = state();
  const call = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_settings')
        current.settings = args!.settings as NativeState['settings'];
      return structuredClone(current);
    },
  );
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  const done = vi.fn();
  render(createElement(AccountPanel, { service, onDone: done }));
  fireEvent.click(screen.getByRole('button', { name: /^离线登录$/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '离线用户名' }), {
    target: { value: 'EasyPlayer' },
  });
  fireEvent.click(screen.getByRole('button', { name: '使用离线账户' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(current.settings.launchMode).toBe('offline');
  expect(current.settings.offlineName).toBe('EasyPlayer');
  expect(
    call.mock.calls.some(([command]) => command === 'native_login_begin'),
  ).toBe(false);
  service.stop();
});
test('memory information is validated before it reaches controls', async () => {
  const call = vi.fn(async () => ({
    totalMb: 8192,
    availableMb: 9000,
    recommendedMb: 4096,
    reserveMb: 1024,
  }));
  const service = createNativeService(true, call as typeof invoke);
  await expect(service.memory()).rejects.toThrow('响应无效');
  service.stop();
});
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
