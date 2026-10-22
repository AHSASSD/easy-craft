import { afterEach, expect, test, vi } from 'vitest';
import { createDemoLaunch } from '../src/core/tasks/demo-launch';
import { createLaunchTask } from '../src/core/tasks/launch-task';
import { createInstances, createPreferences } from '../src/core/services';
import { PluginManager } from '../src/core/plugins/kernel';
import { officialPlugins } from '../src/plugins/official';
import type { LaunchProgress } from '../src/core/contracts';
afterEach(() => vi.useRealTimers());
test('simulation completes all steps and records only simulated last use', async () => {
  const instances = createInstances(createPreferences());
  const events: LaunchProgress[] = [];
  const service = createDemoLaunch(
    instances,
    (progress) => events.push(progress),
    1,
  );
  const logs: LaunchProgress[] = [];
  for await (const progress of service.simulateLaunch(
    instances.snapshot()[0].id,
  ))
    logs.push(progress);
  expect(logs).toHaveLength(8);
  expect(logs.at(-1)).toMatchObject({
    step: 'finish',
    status: 'done',
    percent: 100,
  });
  expect(events).toEqual(logs);
  expect(instances.snapshot()[0].lastPlayedAt).toBeTruthy();
  expect(service.activeCount()).toBe(0);
});
test('cancel clears timer and abort listener, permits retry', async () => {
  vi.useFakeTimers();
  const instances = createInstances(createPreferences());
  const service = createDemoLaunch(instances, () => {}, 650);
  const task = createLaunchTask(service);
  const running = task.start(instances.snapshot()[0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(1);
  task.cancel();
  await running;
  expect(task.snapshot().status).toBe('cancelled');
  expect(service.activeCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const retry = task.start(instances.snapshot()[0]);
  await vi.runAllTimersAsync();
  await retry;
  expect(task.snapshot().status).toBe('done');
});
test('pre-cancelled task does not start timers or mark played', async () => {
  vi.useFakeTimers();
  const instances = createInstances(createPreferences());
  const service = createDemoLaunch(instances, () => {});
  const controller = new AbortController();
  controller.abort();
  const logs: LaunchProgress[] = [];
  for await (const progress of service.simulateLaunch(
    instances.snapshot()[0].id,
    controller.signal,
  ))
    logs.push(progress);
  expect(logs).toHaveLength(1);
  expect(logs[0].status).toBe('cancelled');
  expect(vi.getTimerCount()).toBe(0);
  expect(instances.snapshot()[0].lastPlayedAt).toBeUndefined();
});
test('missing instance fails with actionable demo error, no success timestamp', async () => {
  const instances = createInstances(createPreferences());
  const service = createDemoLaunch(instances, () => {}, 1);
  const task = createLaunchTask(service);
  await task.start(instances.snapshot()[2]);
  expect(task.snapshot().status).toBe('failed');
  expect(task.snapshot().logs.at(-1)?.message).toContain('失败态演示');
  expect(instances.snapshot()[2].lastPlayedAt).toBeUndefined();
});
test('app disposal aborts active task and does not notify removed UI', async () => {
  vi.useFakeTimers();
  const instances = createInstances(createPreferences());
  const service = createDemoLaunch(instances, () => {});
  const task = createLaunchTask(service);
  const notify = vi.fn();
  task.subscribe(notify);
  const running = task.start(instances.snapshot()[0]);
  await vi.advanceTimersByTimeAsync(1);
  task.dispose();
  const before = notify.mock.calls.length;
  await running;
  expect(notify).toHaveBeenCalledTimes(before);
  expect(service.activeCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
test('stopping official plugins aborts pending simulation and leaves no timers', async () => {
  vi.useFakeTimers();
  const kernel = new PluginManager(createPreferences());
  await kernel.load(officialPlugins());
  const instances = kernel.getService('instances');
  const launch = kernel.getService('launch');
  const task = createLaunchTask(launch);
  const running = task.start(instances.snapshot()[0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(1);
  await kernel.stop();
  await running;
  expect(task.snapshot().status).toBe('cancelled');
  expect(vi.getTimerCount()).toBe(0);
  expect(kernel.inspect().services).toEqual(['preferences']);
  const sequence = launch.simulateLaunch(instances.snapshot()[0].id);
  await expect(sequence[Symbol.asyncIterator]().next()).rejects.toThrow(
    '插件已停止',
  );
});
