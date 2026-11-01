import { expect, test } from 'vitest';
import { installProgress } from '../src/core/install-progress';
import type { NativeTask } from '../src/core/native-contracts';
test('planned stages are visible before they run; overall progress survives a phase boundary', () => {
  const task: NativeTask = {
    status: 'running',
    phase: 'pack-download',
    message: '',
    completed: 50,
    total: 100,
    logs: [],
    pid: null,
    plannedStages: ['base', 'content', 'files', 'check', 'publish'],
  };
  const first = installProgress(task);
  expect(first.rows).toHaveLength(5);
  expect(first.rows[4].status).toBe('等待中');
  expect(first.percent).toBe(30);
  const next = installProgress({ ...task, phase: 'pack-files', completed: 0 });
  expect(next.percent).toBeGreaterThan(first.percent);
  expect(installProgress({ ...task, status: 'failed' }).percent).toBeLessThan(
    100,
  );
  expect(
    installProgress({ ...task, status: 'succeeded' }).rows.every(
      (row) => row.percent === 100,
    ),
  ).toBe(true);
});
