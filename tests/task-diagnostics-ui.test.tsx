// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { TaskDiagnostics } from '../src/features/TaskDiagnostics';
import type { NativeState } from '../src/core/native-contracts';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const state: NativeState = {
  dataRoot: 'E:/private',
  settings: {
    javaPath: '',
    clientId: '',
    offlineName: 'FixturePlayer',
    memoryMb: 4096,
    memoryMode: 'auto',
    optimizeMemory: false,
    launchMode: 'offline',
  },
  account: null,
  instances: [],
  loginCode: null,
  loginPending: false,
  task: {
    status: 'failed',
    phase: 'launch',
    message: '未识别的启动错误',
    logs: ['FixturePlayer 原始错误证据'],
    completed: 0,
    total: 0,
    pid: null,
  },
};
test('summary remains visible and selectable if clipboard is unavailable; current task replaces old report', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  const { rerender } = render(<TaskDiagnostics state={state} />);
  const report = screen.getByRole('textbox', {
    name: '诊断摘要',
  }) as HTMLTextAreaElement;
  expect(report.value).toContain('原始错误证据');
  expect(report.value).not.toContain('FixturePlayer');
  fireEvent.click(screen.getByRole('button', { name: '复制诊断摘要' }));
  await screen.findByText(/无法访问剪贴板/);
  expect(report.readOnly).toBe(true);
  rerender(
    <TaskDiagnostics
      state={{
        ...state,
        task: { ...state.task, message: '需要 Java 21', logs: ['新任务日志'] },
      }}
    />,
  );
  expect(report.value).toContain('新任务日志');
  expect(report.value).not.toContain('原始错误证据');
  expect(screen.queryByText(/无法访问剪贴板/)).toBeNull();
  expect(screen.getByText(/下一步/).textContent).toContain('64 位 Java');
});
test('copy uses exactly the visible report', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<TaskDiagnostics state={state} />);
  const report = screen.getByRole('textbox', {
    name: '诊断摘要',
  }) as HTMLTextAreaElement;
  fireEvent.click(screen.getByRole('button', { name: '复制诊断摘要' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(report.value));
  await screen.findByText('诊断摘要已复制');
});
