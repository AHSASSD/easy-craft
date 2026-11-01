import { expect, test } from 'vitest';
import { taskAdvice, taskReport } from '../src/core/task-diagnostics';
import type { NativeState } from '../src/core/native-contracts';

test('diagnostics omit account/config objects and mask identities, credentials and paths in task text', () => {
  const state: NativeState = {
    dataRoot: 'E:\\Games\\Private Library',
    settings: {
      clientId: 'private-client',
      javaPath: '',
      offlineName: 'PrivatePlayer',
      memoryMb: 4096,
      memoryMode: 'auto',
      optimizeMemory: false,
      launchMode: 'offline',
    },
    account: {
      id: 'private-account',
      name: 'PrivateAccount',
      xuid: 'private-xuid',
    },
    instances: [],
    loginPending: false,
    loginCode: null,
    task: {
      status: 'failed',
      phase: 'download',
      message: '网络连接失败 PrivatePlayer',
      completed: 0,
      total: 0,
      pid: null,
      logs: [
        'PrivateAccount private-account private-xuid private-client',
        'Bearer secret-bearer',
        'access_token="secret-access" refreshToken=secret-refresh',
        'E:\\Games\\Private Library\\game.log',
        'C:/Users/Private User/game/log.txt',
        '\\\\private-server\\share\\game.log',
        'HTTP 503',
      ],
    },
  };
  const report = taskReport(state);
  for (const secret of [
    'PrivatePlayer',
    'PrivateAccount',
    'private-account',
    'private-xuid',
    'private-client',
    'secret-bearer',
    'secret-access',
    'secret-refresh',
    'Private Library',
    'Private User',
    'private-server',
  ])
    expect(report).not.toContain(secret);
  expect(report).toContain('HTTP 503');
  expect(report).toContain('阶段：download');
});

test('advice offers specific next steps and leaves unknown errors unclassified', () => {
  expect(taskAdvice('需要 Java 21')).toContain('64 位 Java');
  expect(taskAdvice('HTTP 503')).toContain('网络');
  expect(taskAdvice('磁盘已满')).toContain('剩余空间');
  expect(taskAdvice('未知错误')).toContain('查看下方日志');
  expect(taskAdvice('Java heap space: OutOfMemoryError')).toContain('内存分配');
  expect(taskAdvice('C:/Java/java.exe: 未知错误')).toContain('查看下方日志');
});
