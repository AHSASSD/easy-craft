// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useModCheck, LaunchChecks } from '../src/features/LaunchChecks';
import { InstanceOverview } from '../src/features/InstanceOverview';
import { createNativeService } from '../src/app/native-service';
import type { invoke } from '@tauri-apps/api/core';
import type {
  ModCheck,
  NativeService,
  NativeInstance,
  NativeSettings,
} from '../src/core/native-contracts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const report = (id: string, complete = true): ModCheck => ({
  instanceId: id,
  issues: [],
  unchecked: [],
  details: {
    checkedAt: Date.now(),
    scope: 'Fabric fixture',
    complete,
    scannedFiles: 1,
    parsedFiles: 1,
    reusedFiles: 0,
    elapsedMs: 1,
  },
});
const mockService = (modCheck: NativeService['modCheck']) =>
  ({ snapshot: () => ({ available: true }), modCheck }) as NativeService;
function Probe({
  service,
  id,
  revision = 'same',
  running = false,
  automatic = true,
}: {
  service: NativeService;
  id: string;
  revision?: string;
  running?: boolean;
  automatic?: boolean;
}) {
  const value = useModCheck(service, id, revision, running, automatic);
  return createElement(
    'div',
    null,
    createElement(
      'span',
      { 'data-testid': 'report' },
      value.report?.instanceId ?? 'none',
    ),
    createElement('span', { 'data-testid': 'stale' }, String(value.stale)),
    createElement('button', { onClick: () => void value.refresh() }, 'detail'),
    createElement('button', { onClick: () => void value.verify() }, 'verify'),
  );
}
const advance = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
};
test('selection debounce and late responses cannot populate another instance', async () => {
  vi.useFakeTimers();
  const resolves = new Map<string, (value: ModCheck) => void>();
  const call = vi.fn(
    (id: string) =>
      new Promise<ModCheck>((resolve) => resolves.set(id, resolve)),
  );
  const service = mockService(call);
  const view = render(createElement(Probe, { service, id: 'a' }));
  view.rerender(createElement(Probe, { service, id: 'b' }));
  await advance();
  expect(call.mock.calls.map((args) => args[0])).toEqual(['b']);
  view.rerender(createElement(Probe, { service, id: 'c' }));
  await advance();
  await act(async () => resolves.get('c')!(report('c')));
  await act(async () => resolves.get('b')!(report('b')));
  expect(screen.getByTestId('report').textContent).toBe('c');
  view.rerender(createElement(Probe, { service, id: 'c' }));
  await advance();
  expect(call).toHaveBeenCalledTimes(2);
});
test('automatic setting, changed content, focus throttling and forced detailed reads are distinct', async () => {
  vi.useFakeTimers();
  const call = vi.fn(async (id: string) => report(id));
  const service = mockService(call);
  const view = render(
    createElement(Probe, { service, id: 'a', automatic: false }),
  );
  await advance();
  expect(call).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByText('verify')));
  expect(call).toHaveBeenLastCalledWith('a', false);
  view.rerender(
    createElement(Probe, {
      service,
      id: 'a',
      revision: 'changed',
      automatic: false,
    }),
  );
  expect(screen.getByTestId('stale').textContent).toBe('true');
  await act(async () => fireEvent.click(screen.getByText('detail')));
  expect(call).toHaveBeenLastCalledWith('a', true);
  view.rerender(
    createElement(Probe, {
      service,
      id: 'a',
      revision: 'changed',
      automatic: true,
    }),
  );
  await advance();
  const count = call.mock.calls.length;
  fireEvent(window, new Event('focus'));
  await advance();
  expect(call).toHaveBeenCalledTimes(count);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await act(async () => fireEvent(window, new Event('focus')));
  expect(call).toHaveBeenCalledTimes(count + 1);
});
test('native checks merge concurrent reads and serialize a real forced re-read', async () => {
  let release!: () => void;
  const call = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_mod_check') {
        if (!args?.force)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return report('a');
      }
      return null;
    },
  );
  const service = createNativeService(true, call as typeof invoke);
  const first = service.modCheck('a'),
    second = service.modCheck('a'),
    forced = service.modCheck('a', true);
  expect(first).toBe(second);
  await Promise.resolve();
  await Promise.resolve();
  release();
  await Promise.all([first, second, forced]);
  expect(
    call.mock.calls
      .filter((args) => args[0] === 'native_mod_check')
      .map((args) => args[1]),
  ).toEqual([{ id: 'a' }, { id: 'a', force: true }]);
  service.stop();
});
test('incomplete reports never display passed and checking retains direct launch', () => {
  const launch = vi.fn();
  render(
    createElement(LaunchChecks, {
      report: report('a', false),
      busy: true,
      canLaunch: true,
      onRefresh: vi.fn(),
      onLaunch: launch,
      onFind: vi.fn(),
      onLogs: vi.fn(),
    }),
  );
  expect(screen.queryByText('支持范围内未发现声明问题')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '直接启动' }));
  expect(launch).toHaveBeenCalledOnce();
});
test('overview folder shortcuts use the controlled native folder route and expose failures', async () => {
  const openFolder = vi.fn(async () => {
    throw Error('文件夹尚未生成');
  });
  const service = {
    worlds: async () => [],
    openFolder,
  } as unknown as NativeService;
  const instance = {
    id: 'local-test',
    name: 'Local',
    version: '1.20.1',
    javaMajor: 17,
    fabricVersion: '',
    launch: { gameIsolation: false },
  } as NativeInstance;
  await act(async () =>
    render(
      createElement(InstanceOverview, {
        service,
        instance,
        settings: {} as NativeSettings,
        identity: '',
        running: false,
        onWorlds: vi.fn(),
        onMods: vi.fn(),
        onSettings: vi.fn(),
        onChecks: vi.fn(),
        report: vi.fn(),
      }),
    ),
  );
  expect(screen.getByText('共享游戏目录')).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: /模组文件夹/ })),
  );
  expect(openFolder).toHaveBeenCalledWith('local-test', 'mods');
  expect(screen.getByText('文件夹尚未生成')).toBeTruthy();
});
