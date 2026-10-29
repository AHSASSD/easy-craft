import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
  access,
} from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const data = path.join(project, '.native/mod-preflight', randomUUID());
const output = path.join(project, 'output/playwright/mod-preflight');
const fixtures = path.join(
  project,
  '.native/fixtures/mod-preflight',
  path.basename(data),
);
await mkdir(fixtures, { recursive: true });
await mkdir(output, { recursive: true });
const command = (file, args, options = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000, ...options },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
// Tiny, inert JARs contain only fabric.mod.json; no classes or entrypoints are executed.
const definitions = {
  'dependent.jar': {
    schemaVersion: 1,
    id: 'preflight_example',
    name: '预检测试模组',
    version: '1.0.0',
    depends: { preflight_library: '>=2.0.0' },
  },
  'library.jar': {
    schemaVersion: 1,
    id: 'preflight_library',
    name: '预检测试依赖',
    version: '2.0.0',
  },
  'conflict.jar': {
    schemaVersion: 1,
    id: 'preflight_conflict',
    name: '冲突声明测试',
    version: '1.0.0',
    breaks: { preflight_library: '*' },
  },
};
await writeFile(
  path.join(fixtures, 'definitions.json'),
  JSON.stringify(definitions),
);
const ps = `Add-Type -AssemblyName System.IO.Compression
$fixtureRoot = $env:EASYCRAFT_TEST_FIXTURES
$definitions = Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'definitions.json') | ConvertFrom-Json
foreach ($item in $definitions.PSObject.Properties) {
  $stream = [System.IO.File]::Create((Join-Path $fixtureRoot $item.Name))
  $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $entry = $zip.CreateEntry('fabric.mod.json')
    $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($item.Value | ConvertTo-Json -Depth 10 -Compress)) } finally { $writer.Dispose() }
  } finally { $zip.Dispose(); $stream.Dispose() }
}`;
await command(
  'powershell.exe',
  [
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(ps, 'utf16le').toString('base64'),
  ],
  { env: { ...process.env, EASYCRAFT_TEST_FIXTURES: fixtures } },
);
await writeFile(path.join(fixtures, 'broken.jar'), 'not a ZIP');

const baseline = path.join(project, '.native/integration');
const template = JSON.parse(
  await readFile(path.join(baseline, 'instances.json'), 'utf8'),
).find((item) => item.fabricVersion === '0.16.14');
assert(
  template,
  'Run official Fabric integration once to provide a verified cached loader',
);
const instances = ['缺失依赖测试', '完整依赖测试', '在线真实模组测试'].map(
  (name) => ({ ...template, id: randomUUID(), name, launch: undefined }),
);
for (const instance of instances)
  await mkdir(path.join(data, 'instances', instance.id, 'game/mods'), {
    recursive: true,
  });
const game = (index) =>
  path.join(data, 'instances', instances[index].id, 'game');
await copyFile(
  path.join(fixtures, 'library.jar'),
  path.join(game(1), 'mods/library.jar'),
);
for (const relative of [
  `loaders/fabric/${template.fabricSha1}.json`,
  `libraries/net/fabricmc/fabric-loader/${template.fabricVersion}/fabric-loader-${template.fabricVersion}.jar`,
]) {
  await mkdir(path.dirname(path.join(data, relative)), { recursive: true });
  await copyFile(path.join(baseline, relative), path.join(data, relative));
}
const javaRoot = path.resolve(project, '../build-tools/easycraft/java21');
const runtime = (await readdir(javaRoot))[0];
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: path.join(javaRoot, runtime, 'bin/java.exe'),
    memoryMb: 2048,
    memoryMode: 'auto',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'PreflightTest',
  }),
);
await writeFile(path.join(data, 'instances.json'), JSON.stringify(instances));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let failure = '',
  browser,
  page,
  preferences;
child.stderr.on('data', (bytes) => {
  failure = (failure + bytes).slice(-8000);
});
const results = [];
const errors = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const record = (name) => {
  results.push(name);
  console.log(`PASS: ${name}`);
};
async function idle() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await invoke('native_status');
    if (state.task.status !== 'running') return state.task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Task did not finish');
}
async function select(index) {
  await page
    .locator('.library-instance')
    .filter({ hasText: instances[index].name })
    .click();
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  await page.getByLabel('确认内容修改前游戏已关闭').check();
  await page
    .locator('details')
    .filter({ hasText: '拖放与文件选择' })
    .locator('summary')
    .click();
}
async function upload(name) {
  await page
    .getByLabel('导入本地模组', { exact: true })
    .setInputFiles(path.join(fixtures, name));
  await page.getByRole('dialog', { name: '本地 Mod 安装预检' }).waitFor();
}
async function rpcPreview(name, index = 1) {
  const bytes = [...(await readFile(path.join(fixtures, name)))];
  const token = await invoke('native_file_upload_begin', {
    name,
    size: bytes.length,
    target: { kind: 'modPreview', id: instances[index].id },
  });
  await invoke('native_file_upload_chunk', { token, offset: 0, bytes });
  return invoke('native_mod_upload_finish', { token });
}
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw Error(`Desktop exited: ${failure}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser, 'Desktop endpoint unavailable');
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.library-shell').waitFor();
  preferences = await page.evaluate(() =>
    localStorage.getItem('easycraft.preferences.v1'),
  );
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        'easycraft.preferences.v1',
        JSON.stringify({
          selectedId: id,
          theme: 'slate',
          sidebarWidth: 240,
          uiScale: 100,
          layout: 'default',
          navigation: {
            section: 'library',
            instanceTabs: {},
            query: '',
            scroll: {},
          },
        }),
      ),
    instances[0].id,
  );
  await page.reload();
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/resize-native-test-window.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Width',
    '1120',
    '-Height',
    '720',
  ]);
  await select(0);
  const pickerArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
  ];
  await Promise.all([
    page.getByRole('button', { name: /选择本地模组/ }).click(),
    command('powershell.exe', [...pickerArgs, '-Cancel']),
  ]);
  assert.equal(
    await page.getByRole('dialog', { name: '本地 Mod 安装预检' }).count(),
    0,
  );
  await Promise.all([
    page.getByRole('button', { name: /选择本地模组/ }).click(),
    command('powershell.exe', [
      ...pickerArgs,
      '-File',
      path.join(fixtures, 'dependent.jar'),
    ]),
  ]);
  const dialog = page.getByRole('dialog', { name: '本地 Mod 安装预检' });
  await dialog.waitFor();
  assert((await dialog.innerText()).includes('preflight_library'));
  assert(
    await dialog
      .getByRole('button', { name: '仍然安装', exact: true })
      .isDisabled(),
  );
  assert.equal(await exists(path.join(game(0), 'mods/dependent.jar')), false);
  await page.screenshot({
    path: path.join(output, '01-missing-dependency.png'),
  });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await exists(path.join(game(0), 'mods/dependent.jar')), false);
  record('真实桌面：缺失依赖显示于确认页，取消不写入实例');
  await page.locator('[aria-label="本地内容拖放区"]').evaluate(
    (element, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], 'dependent.jar', {
          type: 'application/java-archive',
        }),
      );
      element.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    [...(await readFile(path.join(fixtures, 'dependent.jar')))],
  );
  await dialog.waitFor();
  await dialog.getByLabel('我已阅读预检问题，仍要安装').check();
  await dialog.getByRole('button', { name: '仍然安装', exact: true }).click();
  assert.equal((await idle()).status, 'succeeded');
  assert.deepEqual(
    await readFile(path.join(game(0), 'mods/dependent.jar')),
    await readFile(path.join(fixtures, 'dependent.jar')),
  );
  const installed = await invoke('native_mod_check', { id: instances[0].id });
  assert(
    installed.issues.some((message) => message.includes('preflight_library')),
  );
  record('玩家明确确认后可安装有声明问题的 Mod，安装后仍能诊断问题');

  await select(1);
  await upload('dependent.jar');
  assert((await dialog.innerText()).includes('已解析的声明中未发现问题'));
  assert.equal(
    await dialog.getByLabel('我已阅读预检问题，仍要安装').count(),
    0,
  );
  await page.screenshot({
    path: path.join(output, '02-dependency-satisfied.png'),
  });
  await dialog
    .getByRole('button', { name: '确认安装 Mod', exact: true })
    .click();
  assert.equal((await idle()).status, 'succeeded');
  assert.equal(
    (await invoke('native_mod_check', { id: instances[1].id })).issues.length,
    0,
  );
  record('完整依赖实例：无需风险确认，预检和真实提交成功');

  const conflict = await rpcPreview('conflict.jar');
  assert(
    conflict.preflight.issues.some((message) => message.includes('不兼容')),
  );
  await assert.rejects(
    invoke('native_resource_install', { token: conflict.token }),
    /仍然安装/,
  );
  await writeFile(
    path.join(game(1), 'mods/external.txt'),
    'External instance change',
  );
  await invoke('native_resource_install', {
    token: conflict.token,
    acknowledgeIssues: true,
  });
  const stale = await idle();
  assert.equal(stale.status, 'failed');
  assert.match(stale.message, /变化|改变/);
  assert.equal(await exists(path.join(game(1), 'mods/conflict.jar')), false);
  record('冲突报告要求明确确认；确认也不能绕过实例内容变化保护');
  const tamper = await rpcPreview('conflict.jar');
  const cached = path.join(data, 'file-inputs', `${tamper.token}.part`);
  await writeFile(cached, 'tampered');
  await invoke('native_resource_install', {
    token: tamper.token,
    acknowledgeIssues: true,
  });
  const corrupt = await idle();
  assert.equal(corrupt.status, 'failed');
  assert.match(corrupt.message, /缓存已变化/);
  assert.equal(await exists(path.join(game(1), 'mods/conflict.jar')), false);
  await assert.rejects(rpcPreview('broken.jar'), /压缩|ZIP|归档|JAR/);
  record('缓存篡改和损坏 JAR 拒绝安装，目标文件保持原样');

  // Genuine third-party Modrinth release, resolved and SHA-verified by the real installer.
  const online = await invoke('native_resource_plan', {
    id: instances[2].id,
    kind: 'mod',
    version: 'sOzRw3CG',
    filename: 'ferritecore-7.0.3-fabric.jar',
    worldId: null,
  });
  assert.equal(online.local, false);
  assert.equal(online.preflight.issues.length, 0);
  assert.equal(
    await exists(path.join(game(2), 'mods/ferritecore-7.0.3-fabric.jar')),
    false,
  );
  await invoke('native_resource_install', { token: online.token });
  assert.equal((await idle()).status, 'succeeded');
  for (const file of online.files)
    assert.equal(
      createHash('sha512')
        .update(await readFile(path.join(game(2), file.path)))
        .digest('hex'),
      file.sha512,
    );
  record(
    '真实 FerriteCore 7.0.3 Fabric：在线下载缓存、预检、安装与磁盘 SHA-512 核对通过',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page
    .locator('.context-category-list')
    .getByRole('button', { name: '模组', exact: true })
    .click();
  await page.getByLabel('搜索在线资源').fill('FerriteCore');
  await page.getByRole('button', { name: '搜索资源', exact: true }).click();
  await page
    .getByRole('button', { name: '查看 FerriteCore', exact: true })
    .click({ timeout: 60000 });
  await page.getByLabel('在线资源兼容版本').selectOption('sOzRw3CG');
  await page.getByLabel('资源安装目标实例').selectOption(instances[2].id);
  await page.getByRole('button', { name: '预览安装变更', exact: true }).click();
  await page
    .getByRole('region', { name: 'Mod 安装前预检' })
    .waitFor({ timeout: 60000 });
  await page.getByLabel('确认在线安装前游戏已关闭').check();
  await page
    .getByRole('region', { name: 'Mod 安装前预检' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, '04-online-preview.png') });
  await page.getByRole('button', { name: '确认安装资源', exact: true }).click();
  assert.equal((await idle()).status, 'succeeded');
  record(
    '真实在线 UI 预览与确认提交通过；本地原生选择、文件输入及拖入均已覆盖',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await select(0);
  await page.screenshot({
    path: path.join(output, '03-installed-warning.png'),
  });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        data,
        instances,
        results,
        errors,
        online: { version: 'sOzRw3CG', files: online.files },
        note: '真实桌面与隔离实例文件测试；未运行 Minecraft 或执行测试 JAR。',
      },
      null,
      2,
    ),
  );
  console.log(`Results: ${output}\nIsolated instances: ${data}`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  throw error;
} finally {
  if (page && preferences !== undefined)
    await page
      .evaluate((value) => {
        if (value === null) localStorage.removeItem('easycraft.preferences.v1');
        else localStorage.setItem('easycraft.preferences.v1', value);
      }, preferences)
      .catch(() => {});
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
