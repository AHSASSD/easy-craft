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
import { WorldSettingsPanel } from '../src/features/WorldSettingsPanel';
import { JavaPanel } from '../src/features/JavaPanel';
import { ContentPanel } from '../src/features/ContentPanel';
import { ResourceBrowser } from '../src/features/ResourceBrowser';
import { PackInspector } from '../src/features/PackInspector';
import {
  UnsavedChanges,
  useNavigationGuard,
} from '../src/features/UnsavedChanges';
import type { invoke } from '@tauri-apps/api/core';
import {
  createNativeService,
  validNativeState,
  validResourceDetail,
  validResourcePlan,
} from '../src/app/native-service';
import type { NativeState, WorldSettings } from '../src/core/native-contracts';
// jsdom does not implement the native dialog APIs; browser tests cover the real modal.
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  },
  close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  },
});
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
test('native file picking accepts cancellation, validates previews and does not report an import on cancel', async () => {
  const preview = {
    kind: 'MRPACK',
    name: 'Native fixture',
    files: 1,
    expandedBytes: 12,
    downloads: 0,
    dependencies: [],
    paths: [],
    warnings: [],
  };
  let selection: unknown = null;
  const call = vi.fn(async (command: string) => {
    if (command === 'native_status') return state();
    if (command === 'native_content_pick') return false;
    if (command === 'native_pack_pick') return selection;
    return [];
  });
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  expect(await service.pickContent('instance', 'mods')).toBe(false);
  render(createElement(PackInspector, { service }));
  fireEvent.click(screen.getByRole('button', { name: /从电脑选择/ }));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByRole('alert')).toBeNull();
  selection = preview;
  fireEvent.click(screen.getByRole('button', { name: /从电脑选择/ }));
  await screen.findByText('Native fixture · MRPACK');
  selection = { ...preview, files: 10001 };
  await expect(service.pickPack()).rejects.toThrow('整合包预览响应无效');
  expect(call).toHaveBeenCalledWith('native_content_pick', {
    id: 'instance',
    kind: 'mods',
  });
  service.stop();
});
test('pack installation previews optional files and sends only the frozen token, name and explicit choices', async () => {
  const current = state();
  const plan = {
    token: '11111111-1111-4111-8111-111111111111',
    name: 'Pack fixture',
    packVersion: '1.0',
    gameVersion: '1.21.1',
    fabricVersion: '0.16.14',
    archiveSha512: 'a'.repeat(128),
    files: [
      {
        path: 'mods/required.jar',
        size: 1,
        sha512: 'b'.repeat(128),
        optional: false,
        source: 'download',
      },
      {
        path: 'mods/optional.jar',
        size: 2,
        sha512: 'c'.repeat(128),
        optional: true,
        source: 'download',
      },
    ],
  };
  const preview = {
    kind: 'MRPACK',
    name: 'Pack fixture',
    files: 1,
    expandedBytes: 1,
    downloads: 2,
    dependencies: [],
    paths: [],
    warnings: [],
    install: plan,
  };
  let response: unknown = preview;
  const call = vi.fn(async (command: string) => {
    if (command === 'native_pack_pick') return response;
    if (command === 'native_pack_install') {
      current.task.status = 'running';
      return;
    }
    return structuredClone(current);
  });
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  render(createElement(PackInspector, { service }));
  fireEvent.click(screen.getByRole('button', { name: /从电脑选择/ }));
  await screen.findByLabelText('整合包新实例名称');
  expect(
    (
      screen.getByLabelText(
        '安装可选文件 mods/optional.jar',
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByLabelText('安装可选文件 mods/optional.jar'));
  fireEvent.change(screen.getByLabelText('整合包新实例名称'), {
    target: { value: 'My pack' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认变更并安装整合包' }));
  await screen.findByText('整合包安装任务已开始，请查看底部任务状态。');
  expect(call).toHaveBeenCalledWith('native_pack_install', {
    token: plan.token,
    name: 'My pack',
    selected: ['mods/optional.jar'],
  });
  response = {
    ...preview,
    install: { ...plan, files: [{ ...plan.files[0], path: '../outside.jar' }] },
  };
  await expect(service.pickPack()).rejects.toThrow('整合包预览响应无效');
  service.stop();
});
function LeaveEditor({ onLeave }: { onLeave(): void }) {
  const guard = useNavigationGuard();
  return createElement('button', { onClick: () => guard(onLeave) }, '离开表单');
}
test('unsaved Java changes block navigation, preserve errors, and save before leaving', async () => {
  const current = state();
  let fail = true;
  const call = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_settings') {
        if (fail) throw '模拟磁盘错误';
        current.settings = args!.settings as NativeState['settings'];
      }
      return structuredClone(current);
    },
  );
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  const leave = vi.fn();
  render(
    createElement(UnsavedChanges, {
      children: [
        createElement(JavaPanel, { service, key: 'java' }),
        createElement(LeaveEditor, { onLeave: leave, key: 'leave' }),
      ],
    }),
  );
  fireEvent.change(screen.getByLabelText('Java 可执行文件'), {
    target: { value: 'E:/new/java.exe' },
  });
  fireEvent.click(screen.getByText('离开表单'));
  await screen.findByRole('dialog', { name: '有尚未保存的修改' });
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('保存并离开'));
  await screen.findByRole('alert');
  expect(leave).not.toHaveBeenCalled();
  expect(
    (screen.getByLabelText('Java 可执行文件') as HTMLInputElement).value,
  ).toBe('E:/new/java.exe');
  fail = false;
  fireEvent.click(screen.getByText('保存并离开'));
  await waitFor(() => expect(leave).toHaveBeenCalledOnce());
  expect(current.settings.javaPath).toBe('E:/new/java.exe');
  service.stop();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
test('online install requires a native frozen plan and closed-game acknowledgement, sends only its token', async () => {
  const current = state();
  current.instances = [
    {
      id: 'instance',
      name: 'Fixture',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '0.16.14',
      fabricSha1: 'b'.repeat(40),
    },
  ];
  const detail = {
    id: 'Proj1234',
    title: 'Fixture',
    description: 'Fixture',
    body: 'Fixture',
    versions: [
      {
        id: 'Vers1234',
        name: '1',
        number: '1',
        environment: 'unknown',
        loaders: ['fabric'],
        files: [{ filename: 'fixture.jar', size: 10, sha1: 'a'.repeat(40) }],
        dependencies: [],
      },
    ],
  };
  const plan = {
    token: '11111111-1111-4111-8111-111111111111',
    instanceId: 'instance',
    gameVersion: '1.21.1',
    files: [
      {
        project: 'Proj1234',
        version: 'Vers1234',
        path: 'mods/fixture.jar',
        size: 10,
        sha1: 'a'.repeat(40),
        sha512: 'b'.repeat(128),
        action: 'add',
      },
    ],
    warnings: [],
  };
  expect(validResourcePlan(plan)).toBe(true);
  expect(
    validResourcePlan({
      ...plan,
      files: [{ ...plan.files[0], path: '../outside.jar' }],
    }),
  ).toBe(false);
  const call = vi.fn(async (command: string) => {
    if (command === 'native_resource_search')
      return {
        hits: [
          {
            id: 'Proj1234',
            title: 'Fixture',
            description: 'Fixture',
            author: 'Fixture',
          },
        ],
        total: 1,
        offset: 0,
      };
    if (command === 'native_resource_detail') return detail;
    if (command === 'native_resource_plan') return plan;
    return current;
  });
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  render(
    createElement(ResourceBrowser, {
      service,
      kind: 'mod',
      query: 'Fixture',
      gameVersion: '1.21.1',
      selectedId: 'instance',
      onFilter: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByText('搜索资源'));
  await screen.findByText('查看 Fixture');
  fireEvent.click(screen.getByText('查看 Fixture'));
  await screen.findByLabelText('在线资源兼容版本');
  fireEvent.click(screen.getByText('预览安装变更'));
  await screen.findByLabelText('资源安装变更预览');
  expect((screen.getByText('确认安装资源') as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    call.mock.calls.some(([command]) => command === 'native_resource_install'),
  ).toBe(false);
  fireEvent.click(screen.getByLabelText('确认在线安装前游戏已关闭'));
  fireEvent.click(screen.getByText('确认安装资源'));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('native_resource_install', {
      token: plan.token,
    }),
  );
  service.stop();
});
test('content manager shows native metadata, requires closed game, and sends the file revision', async () => {
  const row = {
    file: 'fixture.jar',
    name: 'Fixture Mod',
    version: '1.0',
    enabled: true,
    editable: true,
    bytes: 128,
    revision: '128:42',
  };
  const call = vi.fn(async (command: string) =>
    command === 'native_content' ? [row] : state(),
  );
  const service = createNativeService(true, call as typeof invoke);
  render(
    createElement(ContentPanel, {
      service,
      id: 'instance',
      kind: 'mods',
      running: false,
      onDownload: vi.fn(),
      query: '',
      onQuery: vi.fn(),
    }),
  );
  await screen.findByText('Fixture Mod');
  const toggle = screen.getByLabelText(
    '启用模组 Fixture Mod',
  ) as HTMLInputElement;
  expect(toggle.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('确认内容修改前游戏已关闭'));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('native_content_toggle', {
      id: 'instance',
      file: 'fixture.jar',
      revision: '128:42',
      enabled: false,
    }),
  );
  service.stop();
});
test('a fresh status waits for the in-flight poll and then reads the host again', async () => {
  const current = state();
  let resolveFirst!: (value: NativeState) => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<NativeState>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementation(async () => structuredClone(current));
  const service = createNativeService(true, call as typeof invoke);
  const poll = service.refresh();
  const fresh = service.refresh(true);
  const old = state();
  old.task.status = 'running';
  current.task.status = 'cancelled';
  resolveFirst(old);
  await Promise.all([poll, fresh]);
  expect(service.snapshot().state?.task.status).toBe('cancelled');
  expect(call).toHaveBeenCalledTimes(2);
  service.stop();
});
test('datapack browsing requires a concrete world and rejects a plan for another world', async () => {
  const current = state();
  current.instances = [
    {
      id: 'instance',
      name: 'Vanilla',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
    },
  ];
  const detail = {
    id: 'Proj1234',
    title: 'Data Fixture',
    description: 'Fixture',
    body: 'Fixture',
    versions: [
      {
        id: 'Vers1234',
        name: '1',
        number: '1',
        environment: 'unknown',
        loaders: ['datapack'],
        files: [{ filename: 'fixture.zip', size: 10, sha1: 'a'.repeat(40) }],
        dependencies: [],
      },
    ],
  };
  const plan = {
    token: '11111111-1111-4111-8111-111111111111',
    instanceId: 'instance',
    gameVersion: '1.21.1',
    worldId: 'World_A',
    dataFormat: [48, 0],
    files: [
      {
        project: 'Proj1234',
        version: 'Vers1234',
        path: 'datapacks/fixture.zip',
        size: 10,
        sha1: 'a'.repeat(40),
        sha512: 'b'.repeat(128),
        action: 'add',
      },
    ],
    warnings: [],
  };
  const call = vi.fn(async (command: string) => {
    if (command === 'native_worlds')
      return [{ id: 'World_A', name: 'World A' }];
    if (command === 'native_resource_search')
      return {
        hits: [
          {
            id: 'Proj1234',
            title: 'Data Fixture',
            description: 'Fixture',
            author: 'Fixture',
          },
        ],
        total: 1,
        offset: 0,
      };
    if (command === 'native_resource_detail') return detail;
    if (command === 'native_resource_plan') return plan;
    return current;
  });
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  const onWorld = vi.fn();
  render(
    createElement(ResourceBrowser, {
      service,
      kind: 'datapack',
      query: 'Fixture',
      gameVersion: '1.21.1',
      selectedId: 'instance',
      onFilter: vi.fn(),
      onWorldSelection: onWorld,
    }),
  );
  fireEvent.click(screen.getByText('搜索资源'));
  await screen.findByText('查看 Data Fixture');
  fireEvent.click(screen.getByText('查看 Data Fixture'));
  await screen.findByLabelText('数据包目标世界');
  expect((screen.getByText('预览安装变更') as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText('数据包目标世界'), {
    target: { value: 'World_A' },
  });
  expect(onWorld).toHaveBeenCalledWith('instance', 'World_A');
  fireEvent.click(screen.getByText('预览安装变更'));
  await screen.findByLabelText('资源安装变更预览');
  expect(call).toHaveBeenCalledWith('native_resource_plan', {
    id: 'instance',
    kind: 'datapack',
    version: 'Vers1234',
    filename: 'fixture.zip',
    worldId: 'World_A',
  });
  await expect(
    service.planResources(
      'instance',
      'datapack',
      'Vers1234',
      'fixture.zip',
      'World_B',
    ),
  ).rejects.toThrow('安装计划响应无效');
  expect(
    call.mock.calls.some(([command]) => command === 'native_resource_install'),
  ).toBe(false);
  service.stop();
});
test('state-changing native operations refresh after an older in-flight poll', async () => {
  const current = state();
  let first = true;
  let resolvePoll!: (value: NativeState) => void;
  const call = vi.fn(async (command: string) => {
    if (command === 'native_resource_install') {
      current.task.status = 'running';
      return;
    }
    if (command === 'native_status' && first) {
      first = false;
      return new Promise<NativeState>((resolve) => {
        resolvePoll = resolve;
      });
    }
    return structuredClone(current);
  });
  const service = createNativeService(true, call as typeof invoke);
  const poll = service.refresh();
  const operation = service.installResources(
    '11111111-1111-4111-8111-111111111111',
  );
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith('native_resource_install', {
      token: '11111111-1111-4111-8111-111111111111',
    }),
  );
  resolvePoll(state());
  await Promise.all([poll, operation]);
  expect(service.snapshot().state?.task.status).toBe('running');
  service.stop();
});
test('resource browsing validates files, preserves results on network failure and shows declared dependencies', async () => {
  const detail = {
    id: 'Test1234',
    title: 'Resource Fixture',
    description: 'Metadata only',
    body: '<script>unsafe()</script>',
    versions: [
      {
        id: 'Vers1234',
        name: 'Test Version',
        number: '1',
        environment: 'unknown',
        loaders: ['fabric'],
        files: [{ filename: 'fixture.jar', size: 100, sha1: 'a'.repeat(40) }],
        dependencies: [
          { projectId: 'Deps1234', versionId: null, kind: 'required' },
        ],
      },
    ],
  };
  expect(validResourceDetail(detail)).toBe(true);
  expect(
    validResourceDetail({
      ...detail,
      versions: [
        {
          ...detail.versions[0],
          files: [{ filename: 'bad', size: NaN, sha1: 'bad' }],
        },
      ],
    }),
  ).toBe(false);
  let fail = false;
  const call = vi.fn(async (command: string) => {
    if (command === 'native_resource_search') {
      if (fail) throw '断网测试';
      return {
        hits: [
          {
            id: 'Test1234',
            title: detail.title,
            description: detail.description,
            author: 'Author',
          },
        ],
        total: 1,
        offset: 0,
      };
    }
    if (command === 'native_resource_detail') return detail;
    return state();
  });
  const service = createNativeService(true, call as typeof invoke);
  render(
    createElement(ResourceBrowser, {
      service,
      kind: 'mod',
      query: 'fixture',
      gameVersion: '1.21.1',
      onFilter: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByText('搜索资源'));
  await screen.findByRole('heading', { name: 'Resource Fixture' });
  fail = true;
  fireEvent.click(screen.getByText('搜索资源'));
  await screen.findByText('断网测试');
  expect(
    screen.getByRole('heading', { name: 'Resource Fixture' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByText('查看 Resource Fixture'));
  await screen.findByText(/必需：Deps1234/);
  expect(
    screen.queryByText(
      '此版本 API 未列出额外项目依赖；加载器与运行条件仍需检查。',
      { exact: true },
    ),
  ).toBeNull();
  expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy();
  expect(document.querySelector('.resource-description script')).toBeNull();
  fireEvent.click(screen.getByText('返回搜索结果'));
  expect(
    screen.getByRole('heading', { name: 'Resource Fixture' }),
  ).toBeTruthy();
  service.stop();
});
test('world controls read discovered rules and save only after the closed-game acknowledgement', async () => {
  let world: WorldSettings = {
    revision: 'a'.repeat(40),
    difficulty: 2,
    difficultyLocked: false,
    hardcore: false,
    allowCommands: true,
    gameMode: 0,
    dayTime: '9007199254740993',
    weather: 'clear',
    gameRules: [
      { key: 'keepInventory', value: 'false', kind: 'boolean' },
      { key: 'randomTickSpeed', value: '3', kind: 'integer' },
    ],
  };
  const call = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === 'native_worlds') return [{ id: 'World', name: 'World' }];
      if (command === 'native_world') return structuredClone(world);
      if (command === 'native_options')
        return {
          revision: 'missing',
          masterVolume: 1,
          musicVolume: 1,
          renderDistance: 12,
          fullscreen: false,
        };
      if (command === 'native_world_save') {
        world = args!.settings as WorldSettings;
        return 'backup/level.dat';
      }
      return state();
    },
  );
  const service = createNativeService(true, call as typeof invoke);
  render(
    createElement(WorldSettingsPanel, {
      service,
      id: 'instance',
      running: false,
    }),
  );
  await screen.findByLabelText('死亡不掉落');
  expect((screen.getByLabelText('世界时间') as HTMLInputElement).value).toBe(
    '9007199254740993',
  );
  const save = screen.getByRole('button', {
    name: '保存世界设置与规则',
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('确认游戏已关闭'));
  fireEvent.click(screen.getByLabelText('死亡不掉落'));
  fireEvent.change(screen.getByLabelText('随机刻速度'), {
    target: { value: '6' },
  });
  fireEvent.click(save);
  await screen.findByText('已保存，原文件已备份：backup/level.dat');
  expect(world.gameRules.map((rule) => rule.value)).toEqual(['true', '6']);
  service.stop();
});
test('a delayed avatar response cannot replace the newly selected identity', async () => {
  const current = state();
  let resolveAvatar!: (value: string) => void;
  const call = vi.fn(async (command: string) =>
    command === 'native_avatar'
      ? new Promise<string>((resolve) => {
          resolveAvatar = resolve;
        })
      : structuredClone(current),
  );
  const service = createNativeService(true, call as typeof invoke);
  await service.refresh();
  const pending = service.avatar();
  current.settings.launchMode = 'offline';
  current.settings.offlineName = 'NewPlayer';
  await service.refresh();
  resolveAvatar('data:image/png;base64,AAAA');
  await pending;
  expect(service.snapshot().avatar).toBeNull();
  service.stop();
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
