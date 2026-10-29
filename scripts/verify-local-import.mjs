import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  link,
  copyFile,
} from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const id = randomUUID();
const data = path.join(project, '.native/local-import', id);
const fixtures = path.join(project, '.native/fixtures/local-import', id);
const source = path.join(fixtures, 'source');
const baseline = path.join(project, '.native/integration');
const output = path.join(project, 'output/playwright/local-import');
const command = (file, args, options = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000, ...options },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${error.message}\n${stderr}`))
          : resolve(stdout),
    ),
  );
await mkdir(data, { recursive: true });
await mkdir(fixtures, { recursive: true });
await mkdir(output, { recursive: true });
const template = JSON.parse(
  await readFile(path.join(baseline, 'instances.json'), 'utf8'),
).find((v) => v.fabricVersion === '0.16.14');
assert(template, 'Verified 1.21.1/Fabric integration cache is required');
await mkdir(path.join(source, 'versions/原版目录别名'), { recursive: true });
await mkdir(path.join(source, 'versions/Fabric本地'), { recursive: true });
await mkdir(path.join(source, 'versions/不支持Forge'), { recursive: true });
await mkdir(path.join(source, 'versions/损坏JSON'), { recursive: true });
await copyFile(
  path.join(
    baseline,
    `versions/${template.version}/${template.manifestSha1}.json`,
  ),
  path.join(source, 'versions/原版目录别名/renamed.json'),
);
await link(
  path.join(baseline, `versions/${template.version}/client.jar`),
  path.join(source, 'versions/原版目录别名/renamed.jar'),
);
const profile = JSON.parse(
  await readFile(
    path.join(baseline, `loaders/fabric/${template.fabricSha1}.json`),
    'utf8',
  ),
);
await writeFile(
  path.join(source, 'versions/Fabric本地/Fabric本地.json'),
  JSON.stringify({ ...profile, id: 'custom-fabric-name' }),
);
await writeFile(
  path.join(source, 'versions/不支持Forge/不支持Forge.json'),
  JSON.stringify({
    id: 'forge-example',
    mainClass: 'cpw.mods.modlauncher.Launcher',
    libraries: [],
  }),
);
await writeFile(
  path.join(source, 'versions/损坏JSON/损坏JSON.json'),
  '{broken',
);
async function linkTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory())
      await linkTree(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile())
      await link(path.join(from, entry.name), path.join(to, entry.name));
    else throw Error('Fixture cache contains unsupported link');
  }
}
for (const folder of ['libraries', 'assets'])
  await linkTree(path.join(baseline, folder), path.join(source, folder));
await mkdir(path.join(source, 'config'), { recursive: true });
await writeFile(
  path.join(source, 'config/example.json'),
  '{"localImportVerification":true}',
);
await writeFile(path.join(source, 'options.txt'), 'music:0.5\n');
await writeFile(
  path.join(source, 'launcher_accounts.json'),
  'DO-NOT-READ-OR-COPY',
);
await writeFile(path.join(data, 'instances.json'), '[]');
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: '',
    memoryMb: 2048,
    memoryMode: 'auto',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'ImportTest',
  }),
);
const archive = path.join(fixtures, 'preview.zip');
await command(
  'powershell.exe',
  [
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(
      `Add-Type -AssemblyName System.IO.Compression
$stream=[IO.File]::Create($env:EASYCRAFT_IMPORT_ZIP)
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try { $entry=$zip.CreateEntry('README.txt'); $writer=[IO.StreamWriter]::new($entry.Open()); try { $writer.Write('inert import preview fixture') } finally { $writer.Dispose() } } finally { $zip.Dispose(); $stream.Dispose() }`,
      'utf16le',
    ).toString('base64'),
  ],
  { env: { ...process.env, EASYCRAFT_IMPORT_ZIP: archive } },
);
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  },
);
let browser, page, originalPreferences;
const results = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const log = (name) => {
  results.push(name);
  console.log(`PASS: ${name}`);
};
const shot = (name) =>
  page.screenshot({ path: path.join(output, `${name}.png`) });
async function dialog(file, directory = false) {
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    ...(file
      ? ['-File', file, ...(directory ? ['-Directory'] : [])]
      : ['-Cancel']),
  ]);
}
async function scan(folder) {
  const task = invoke('native_local_scan_pick');
  void task.catch(() => {});
  await dialog(folder, true);
  return task;
}
async function waitTask(status) {
  const limit = Date.now() + 240000;
  let value;
  while (Date.now() < limit) {
    value = await invoke('native_status');
    if (value.task.status !== 'running') {
      assert.equal(value.task.status, status, JSON.stringify(value.task));
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Task timeout: ${JSON.stringify(value?.task)}`);
}
try {
  for (let i = 0; i < 50; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.library-shell').waitFor();
  originalPreferences = await page.evaluate(() =>
    localStorage.getItem('easycraft.preferences.v1'),
  );
  await page.evaluate(() =>
    localStorage.setItem(
      'easycraft.preferences.v1',
      JSON.stringify({
        selectedId: '',
        doubleClickLaunch: false,
        developerEnabled: false,
        sort: 'recent',
        theme: 'slate',
        sidebarWidth: 240,
        layout: 'default',
        uiScale: 100,
        navigation: {
          section: 'library',
          settingsCategory: 'launch',
          downloadCategory: 'vanilla',
          instanceTabs: {},
          query: '',
          scroll: {},
        },
      }),
    ),
  );
  await page.reload();
  await page.locator('.library-shell').waitFor();
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
  const geometry = await page.locator('.sidebar-search').evaluate((e) => {
    const label = e.getBoundingClientRect(),
      input = e.querySelector('input').getBoundingClientRect(),
      icon = e.querySelector('svg').getBoundingClientRect();
    return {
      text: (input.top + input.bottom) / 2,
      icon: (icon.top + icon.bottom) / 2,
      box: (label.top + label.bottom) / 2,
      lineHeight: getComputedStyle(e.querySelector('input')).lineHeight,
    };
  });
  assert(
    Math.abs(geometry.text - geometry.icon) < 1.1 &&
      Math.abs(geometry.box - geometry.text) < 1.1,
    JSON.stringify(geometry),
  );
  await shot('00-centered-search');
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .waitFor();
  await shot('01-add-menu-centered-search');
  await page.keyboard.press('Escape');
  assert(
    await page
      .getByRole('button', { name: '添加游戏实例', exact: true })
      .evaluate((e) => e === document.activeElement),
  );
  log('1120×720 搜索文字/图标垂直居中，加号菜单与 Esc 焦点');
  await page.locator('.library-import-link').click();
  await dialog();
  assert.equal(await page.locator('[aria-label="导入本地整合包"]').count(), 0);
  assert.equal((await invoke('native_status')).instances.length, 0);
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '导入本地整合包', exact: true })
    .click();
  await dialog(archive);
  await page
    .getByRole('dialog', { name: '导入本地整合包', exact: true })
    .waitFor();
  await shot('02-direct-pack-preview');
  await page
    .getByRole('dialog', { name: '导入本地整合包', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  log(
    '底部按钮直接打开系统文件窗口，取消无写入；加号选择 ZIP 直接进入真实预览',
  );
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .click();
  await page
    .getByRole('button', { name: '选择目录并扫描', exact: true })
    .click();
  await dialog();
  assert.equal(
    await page
      .getByRole('dialog', { name: '扫描/导入本地版本', exact: true })
      .getByRole('alert')
      .count(),
    0,
  );
  await page
    .getByRole('button', { name: '选择目录并扫描', exact: true })
    .click();
  await dialog(source, true);
  await page
    .getByLabel('导入 原版目录别名', { exact: true })
    .waitFor({ timeout: 30000 });
  assert(
    await page.getByLabel('导入 不支持Forge', { exact: true }).isDisabled(),
  );
  assert(await page.getByLabel('导入 损坏JSON', { exact: true }).isDisabled());
  await shot('03-real-local-scan');
  log('系统文件夹选择与真实本地扫描界面通过');
  await page
    .getByRole('dialog', { name: '扫描/导入本地版本', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  const initial = await scan(source);
  const vanilla = initial.candidates.find((v) => v.name === '原版目录别名');
  assert.equal(vanilla.gameVersion, '1.21.1');
  assert(vanilla.supported);
  await writeFile(path.join(source, 'options.txt'), 'changed after preview');
  await invoke('native_local_import', {
    token: initial.token,
    selected: [{ id: vanilla.id, name: 'stale should fail', mode: 'copy' }],
  });
  assert.equal((await waitTask('failed')).instances.length, 0);
  await writeFile(path.join(source, 'options.txt'), 'music:0.5\n');
  log(
    '目录别名正确解析真实版本；Forge/损坏 JSON 显示不可导入；预览后文件变化拒绝且无实例',
  );
  const cancellable = await scan(path.join(source, 'versions/原版目录别名'));
  await invoke('native_local_import', {
    token: cancellable.token,
    selected: [
      { id: cancellable.candidates[0].id, name: 'cancelled', mode: 'copy' },
    ],
  });
  await invoke('native_cancel');
  assert.equal((await waitTask('cancelled')).instances.length, 0);
  log('原生导入任务取消不会添加未完成实例');
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .click();
  await page
    .getByRole('button', { name: '选择目录并扫描', exact: true })
    .click();
  await dialog(path.join(source, 'versions'), true);
  await page
    .getByLabel('导入 原版目录别名', { exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByLabel('导入 原版目录别名', { exact: true }).check();
  await page.getByLabel('导入 Fabric本地', { exact: true }).check();
  for (const name of ['原版目录别名', 'Fabric本地']) {
    await page
      .locator('.scan-version-row')
      .filter({ has: page.getByLabel(`导入 ${name}`, { exact: true }) })
      .locator('summary')
      .click();
  }
  await page
    .getByLabel('实例名称 原版目录别名', { exact: true })
    .fill('已导入原版');
  await page
    .getByLabel('实例名称 Fabric本地', { exact: true })
    .fill('已导入 Fabric');
  assert(
    await page
      .getByRole('button', { name: '导入选中的 2 个版本', exact: true })
      .isEnabled(),
  );
  await page
    .getByRole('combobox', { name: '本地版本添加方式', exact: true })
    .selectOption('copy');
  await page
    .getByRole('button', { name: '导入选中的 2 个版本', exact: true })
    .click();
  await page
    .getByText('导入任务已提交，进度与取消操作可在底部“任务与日志”查看。', {
      exact: true,
    })
    .waitFor();
  const imported = await waitTask('succeeded');
  assert.equal(imported.instances.length, 2);
  await page
    .getByRole('dialog', { name: '扫描/导入本地版本', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page.locator('.library-instance').nth(1).waitFor();
  await shot('04-imported-library');
  for (const item of imported.instances) {
    const game = path.join(data, 'instances', item.id, 'game');
    assert.equal(
      await readFile(path.join(game, 'options.txt'), 'utf8'),
      'music:0.5\n',
    );
    assert.equal(
      await readFile(path.join(game, 'config/example.json'), 'utf8'),
      '{"localImportVerification":true}',
    );
    await assert.rejects(readFile(path.join(game, 'launcher_accounts.json')));
    const hash = JSON.parse(
      await readFile(path.join(game, '.easycraft-local-import.json'), 'utf8'),
    ).sourceKey;
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(item.version, '1.21.1');
    const metadata = JSON.parse(
      await readFile(
        path.join(data, `versions/${item.version}/${item.manifestSha1}.json`),
        'utf8',
      ),
    );
    const client = await readFile(
      path.join(data, `versions/${item.version}/client.jar`),
    );
    assert.equal(
      createHash('sha1').update(client).digest('hex'),
      metadata.downloads.client.sha1,
    );
    if (item.fabricVersion) {
      assert.equal(item.fabricVersion, '0.16.14');
      await readFile(path.join(data, `loaders/fabric/${item.fabricSha1}.json`));
    }
  }
  assert.equal(
    await readFile(path.join(source, 'options.txt'), 'utf8'),
    'music:0.5\n',
  );
  assert.equal(
    await readFile(path.join(source, 'launcher_accounts.json'), 'utf8'),
    'DO-NOT-READ-OR-COPY',
  );
  const duplicates = await scan(source);
  assert.equal(duplicates.candidates.filter((v) => v.duplicate).length, 2);
  log(
    '真实 1.21.1 原版与 Fabric 0.16.14 导入成功，共享资源已校验复用，游戏内容独立复制，账号文件未复制，重复导入被标明',
  );
  await page.locator('.library-instance').first().click();
  await page.getByRole('tab', { name: '实例设置', exact: true }).click();
  const isolation = page.getByRole('region', {
    name: '此版本的目录隔离',
    exact: true,
  });
  await isolation
    .getByRole('checkbox', { name: '此版本隔离', exact: true })
    .uncheck();
  await isolation
    .getByRole('button', { name: '保存隔离设置', exact: true })
    .click();
  await isolation.getByText(/游戏目录设置已保存/).waitFor();
  const switched = (await invoke('native_status')).instances.find(
    (v) => v.launch?.gameIsolation === false,
  );
  assert(switched);
  assert.equal(
    await readFile(
      path.join(data, `instances/${switched.id}/game/options.txt`),
      'utf8',
    ),
    'music:0.5\n',
  );
  await writeFile(
    path.join(data, 'shared-game/options.txt'),
    'soundCategory_music:0.25\n',
  );
  const sharedOptions = await invoke('native_options', { id: switched.id });
  assert.equal(sharedOptions.musicVolume, 0.25);
  await shot('07-isolation-shared-directory');
  // A real streamed input task holds the footer at a known intermediate point; it is cancelled, never installed.
  const upload = await invoke('native_file_upload_begin', {
    name: 'cancelled-progress.zip',
    size: 10000,
    target: { kind: 'pack' },
  });
  await invoke('native_file_upload_chunk', {
    token: upload,
    offset: 0,
    bytes: Array(5000).fill(0x5a),
  });
  await page
    .getByRole('progressbar', { name: '任务进度', exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector('.taskbar-progress progress')?.value === 5000,
  );
  assert(
    await isolation
      .getByRole('checkbox', { name: '此版本隔离', exact: true })
      .isDisabled(),
  );
  await shot('08-native-task-progress-50percent');
  await invoke('native_file_upload_abort', { token: upload });
  await page.waitForFunction(
    () => !document.querySelector('.taskbar-progress'),
  );
  await isolation
    .getByRole('checkbox', { name: '此版本隔离', exact: true })
    .check();
  await isolation
    .getByRole('button', { name: '保存隔离设置', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="此版本隔离"]')?.disabled === false,
  );
  const privateOptions = await invoke('native_options', { id: switched.id });
  assert.equal(privateOptions.musicVolume, 1);
  assert.equal(
    await readFile(path.join(data, 'shared-game/options.txt'), 'utf8'),
    'soundCategory_music:0.25\n',
  );
  log(
    '实际窗口保存版本隔离，配置 API 跟随目录，原目录保留；真实上传任务显示 50% 且取消后清理',
  );
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '启动', exact: true }).click();
  const defaults = page.getByRole('region', {
    name: '新版本默认隔离',
    exact: true,
  });
  await defaults
    .getByRole('checkbox', { name: '默认版本隔离', exact: true })
    .uncheck();
  await defaults
    .getByRole('button', { name: '保存隔离设置', exact: true })
    .click();
  await defaults.getByText(/默认隔离设置已保存/).waitFor();
  const afterDefault = await invoke('native_status');
  assert.equal(afterDefault.settings.isolateNewInstances, false);
  assert(
    afterDefault.instances.every((v) => v.launch?.gameIsolation !== false),
  );
  await shot('09-new-version-default-isolation');
  await page.getByRole('button', { name: '游戏库', exact: true }).click();
  for (const [width, height, zoom] of [
    [1120, 720, 1.25],
    [800, 540, 1],
  ]) {
    await invoke('plugin:webview|set_webview_zoom', {
      label: 'main',
      value: zoom,
    });
    await command('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(project, 'scripts/resize-native-test-window.ps1'),
      '-AppProcessId',
      String(child.pid),
      '-Width',
      String(width),
      '-Height',
      String(height),
    ]);
    if (!(await page.locator('.sidebar-search').isVisible()))
      await page.getByRole('button', { name: '展开或折叠实例栏' }).click();
    const delta = await page.locator('.sidebar-search').evaluate((e) => {
      const input = e.querySelector('input').getBoundingClientRect(),
        icon = e.querySelector('svg').getBoundingClientRect();
      return Math.abs((input.top + input.bottom - icon.top - icon.bottom) / 2);
    });
    assert(delta < 1.1, `Search centering at ${width}/${zoom}: ${delta}`);
    await page.locator('.sidebar-search input').fill('已导入');
    await page.locator('.sidebar-search input').fill('');
    await shot(`05-search-${width}-${zoom}`);
    await page.getByRole('tab', { name: '实例设置', exact: true }).click();
    await page
      .getByRole('checkbox', { name: '此版本隔离', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(`10-isolation-${width}-${zoom}`);
  }
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('easycraft.preferences.v1'));
    value.theme = 'grass';
    localStorage.setItem('easycraft.preferences.v1', JSON.stringify(value));
  });
  await page.reload();
  await page.locator('.library-instance').first().waitFor();
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .waitFor();
  await shot('06-light-minimum-menu');
  await page.keyboard.press('Escape');
  log('125% 缩放、800×540 最小窗口、实际输入与浅色主题菜单通过');
  const artifact = JSON.parse(
    await readFile(path.join(data, 'instances.json'), 'utf8'),
  );
  await writeFile(
    path.join(output, 'imported-instances.json'),
    JSON.stringify({ data, source, instances: artifact }, null, 2),
  );
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      { at: new Date().toISOString(), data, source, results },
      null,
      2,
    ),
  );
  if (page && !page.isClosed() && originalPreferences !== undefined) {
    await page
      .evaluate((value) => {
        if (value === null) localStorage.removeItem('easycraft.preferences.v1');
        else localStorage.setItem('easycraft.preferences.v1', value);
      }, originalPreferences)
      .catch(() => {});
  }
  await browser?.close();
  if (child.exitCode === null) {
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await done;
  }
}
