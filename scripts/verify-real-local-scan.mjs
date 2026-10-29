// Explicit, read-only desktop verification of the Minecraft directory reported in this chat.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const source = path.join(process.env.APPDATA, '.minecraft');
const data = path.join(project, '.native/real-local-scan', randomUUID());
const output = path.join(project, 'output/playwright/local-scan/desktop');
const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) =>
        error ? reject(Error(`${error.message}\n${stderr}`)) : resolve(stdout),
    ),
  );
async function sourceSnapshot() {
  const files = ['options.txt', 'servers.dat'];
  for (const entry of await readdir(path.join(source, 'versions'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(
      path.join(source, 'versions', entry.name),
      { withFileTypes: true },
    )) {
      if (
        file.isFile() &&
        file.name.endsWith('.json') &&
        !/account|auth|token|launcher|hmcl|pcl/i.test(file.name)
      )
        files.push(path.join('versions', entry.name, file.name));
    }
  }
  const result = [];
  for (const file of files) {
    try {
      const value = await stat(path.join(source, file));
      result.push({
        file,
        size: value.size,
        mtime: value.mtimeMs,
        hash: createHash('sha256')
          .update(await readFile(path.join(source, file)))
          .digest('hex'),
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result;
}
await mkdir(data, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(data, 'instances.json'), '[]');
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: '',
    memoryMb: 2048,
    memoryMode: 'auto',
    optimizeMemory: false,
    launchMode: 'microsoft',
    offlineName: '',
  }),
);
const before = await sourceSnapshot();
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
let browser, page;
const results = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const shot = (name) =>
  page.screenshot({ path: path.join(output, `${name}.png`) });
try {
  for (let i = 0; i < 60; i++) {
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .click();
  await page
    .getByRole('button', { name: '选择目录并扫描', exact: true })
    .click();
  const selectedAt = Date.now();
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-File',
    source,
    '-Directory',
    '-ReadOnlyMinecraftRoot',
  ]);
  const dialog = page.getByRole('dialog', {
    name: '扫描/导入本地版本',
    exact: true,
  });
  await dialog
    .getByText('扫描完成，尚未导入', { exact: true })
    .waitFor({ timeout: 30000 });
  const state = await invoke('native_status');
  assert.equal(state.task.status, 'succeeded');
  assert.equal(state.task.phase, 'local-scan-complete');
  assert(state.task.message.includes('尚未导入'));
  assert(state.task.logs.length > 2);
  assert(state.task.logs[0].includes(source));
  assert.equal(state.instances.length, 0);
  const total = await dialog
    .locator('.local-version-candidates article')
    .count();
  assert(total > 0);
  await shot('01-real-c-drive-scan-results');
  results.push({
    check:
      'Real native folder selection and scan completed; summary and reasons are visible',
    total,
    elapsedIncludingPickerMs: Date.now() - selectedAt,
    message: state.task.message,
  });
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '查看扫描结果', exact: true }).click();
  assert.equal(
    await dialog.locator('.local-version-candidates article').count(),
    total,
  );
  await dialog
    .getByRole('button', { name: '选择可导入版本（最多 32 个）', exact: true })
    .click();
  const selected = await dialog
    .locator('.local-version-candidates input[type=checkbox]:checked')
    .count();
  assert(selected > 0);
  assert(
    await dialog
      .getByRole('button', {
        name: `导入选中的 ${selected} 个版本`,
        exact: true,
      })
      .isEnabled(),
  );
  if (total > 20)
    await dialog
      .locator('.local-version-candidates article')
      .nth(20)
      .scrollIntoViewIfNeeded();
  const actionBounds = await dialog
    .locator('.local-import-actions')
    .evaluate((e) => {
      const r = e.getBoundingClientRect(),
        d = e.closest('dialog').getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        dialogTop: d.top,
        dialogBottom: d.bottom,
      };
    });
  assert(
    actionBounds.top >= actionBounds.dialogTop &&
      actionBounds.bottom <= actionBounds.dialogBottom,
    JSON.stringify(actionBounds),
  );
  await shot('02-restored-results-before-explicit-confirmation');
  await dialog
    .getByRole('group', { name: '扫描结果筛选' })
    .getByRole('button', { name: /^可导入/ })
    .click();
  assert(
    (await dialog.locator('.local-version-candidates article').count()) >=
      selected,
  );
  assert(selected <= 32);
  await dialog.getByRole('textbox', { name: '筛选扫描版本' }).fill('1.21.1');
  assert(
    (await dialog.locator('.local-version-candidates article').count()) >= 1,
  );
  await dialog.getByRole('textbox', { name: '筛选扫描版本' }).fill('');
  await shot('04-ready-versions-filter');
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/resize-native-test-window.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Width',
    '800',
    '-Height',
    '540',
  ]);
  await invoke('plugin:webview|set_webview_zoom', {
    label: 'main',
    value: 1.25,
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const minimum = await dialog.evaluate((e) => {
    const d = e.getBoundingClientRect(),
      a = e.querySelector('.local-import-actions').getBoundingClientRect(),
      list = e.querySelector('.local-version-candidates');
    return {
      dialogBottom: d.bottom,
      actionsBottom: a.bottom,
      listHeight: list.clientHeight,
      overflow: e.scrollWidth > e.clientWidth + 1,
      right: d.right,
      width: innerWidth,
      bottom: d.bottom,
      height: innerHeight,
    };
  });
  assert(
    minimum.actionsBottom <= minimum.dialogBottom &&
      minimum.listHeight >= 50 &&
      !minimum.overflow &&
      minimum.right <= minimum.width + 1 &&
      minimum.bottom <= minimum.height + 1,
    JSON.stringify(minimum),
  );
  await shot('05-minimum-125percent-scan-results');
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/resize-native-test-window.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Width',
    '800',
    '-Height',
    '540',
    '-Screenshot',
    path.join(output, '05-minimum-125percent-window.png'),
  ]).catch((error) => {
    if (!error.message.includes('launcher is not foreground')) throw error;
    results.push({
      check:
        'Native window capture skipped because this workspace launcher was not foreground; no other screen pixels captured',
    });
  });
  await invoke('plugin:webview|set_webview_zoom', { label: 'main', value: 1 });
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
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '任务与日志', exact: true }).click();
  const tasks = page.getByRole('dialog', { name: '任务与日志', exact: true });
  await tasks
    .getByRole('button', { name: '查看扫描结果并选择导入', exact: true })
    .waitFor();
  assert((await tasks.locator('pre').innerText()).includes('尚未导入'));
  await shot('03-real-scan-task-log');
  await tasks.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.locator('.theme-card:has(.theme-preview.grass)').click();
  await page.getByRole('button', { name: '查看扫描结果', exact: true }).click();
  await dialog.getByText('扫描完成，尚未导入', { exact: true }).waitFor();
  await shot('06-light-theme-real-scan-results');
  assert.equal((await invoke('native_status')).instances.length, 0);
  if (
    await dialog
      .getByRole('button', { name: '清除选择', exact: true })
      .isEnabled()
  )
    await dialog.getByRole('button', { name: '清除选择', exact: true }).click();
  const names = ['1.16.5', '1.16.5-forge-36.2.34', 'neoforge-21.1.139'];
  for (const name of names)
    await dialog
      .getByRole('checkbox', { name: `导入 ${name}`, exact: true })
      .check();
  assert.equal(
    await dialog
      .getByRole('combobox', { name: '本地版本添加方式', exact: true })
      .inputValue(),
    'reference',
  );
  assert.equal(
    await dialog
      .getByRole('checkbox', { name: '确认本地版本导入范围', exact: true })
      .count(),
    0,
  );
  const importStarted = Date.now();
  await dialog
    .getByRole('button', { name: '导入选中的 3 个版本', exact: true })
    .click();
  let imported;
  for (let attempt = 0; attempt < 300; attempt++) {
    imported = await invoke('native_status');
    if (imported.instances.length === 3 && imported.task.status === 'succeeded')
      break;
    if (imported.task.status === 'failed')
      throw Error(JSON.stringify(imported.task));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(imported.instances.length, 3);
  assert(
    imported.task.message.includes('已成功导入 3 个本地版本'),
    JSON.stringify(imported.task),
  );
  for (const instance of imported.instances) {
    assert(instance.local);
    assert.equal(
      (await readdir(path.join(data, 'instances', instance.id))).length,
      1,
    );
  }
  results.push({
    check:
      'Actual vanilla 1.16.5, Forge and NeoForge registered through desktop UI without copying worlds, network consent, or game execution',
    elapsedIncludingUiMs: Date.now() - importStarted,
    instances: imported.instances.map((v) => ({
      id: v.id,
      name: v.name,
      loader: v.local.loader,
    })),
  });
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '游戏库', exact: true }).click();
  await page.locator('.library-instance').nth(2).waitFor();
  await shot('07-reference-imported-library');
  assert.deepEqual(await sourceSnapshot(), before);
  assert.deepEqual(errors, []);
  results.push({
    check:
      'Closing/reopening preserves candidates; filters and search retain selection; confirmation remains visible at minimum size and 125% zoom; task log links back to results',
    selectable: selected,
  });
  results.push({
    check:
      'Version JSONs and game settings remained byte-identical; reference registration performed without game execution or account login',
    checkedFiles: before.length,
  });
  await page.getByRole('button', { name: '添加游戏实例', exact: true }).click();
  await page
    .getByRole('menuitem', { name: '扫描/导入本地版本', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: '选择目录并扫描', exact: true })
    .click();
  const singleStarted = Date.now();
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-File',
    path.join(source, 'versions/1.16.5'),
    '-Directory',
    '-ReadOnlyMinecraftRoot',
  ]);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.local-version-candidates article').length ===
      1,
  );
  assert.equal(
    await dialog.getByLabel('导入 1.16.5', { exact: true }).isDisabled(),
    true,
  );
  await shot('08-single-version-directory');
  results.push({
    check:
      'Actual single-version folder selection only returns that version; an existing reference is correctly marked duplicate',
    elapsedIncludingPickerMs: Date.now() - singleStarted,
  });
  assert.deepEqual(await sourceSnapshot(), before);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        source,
        data,
        results,
        scanTask: state.task,
        task: imported.task,
      },
      null,
      2,
    ),
  );
  for (const result of results) console.log(`PASS: ${JSON.stringify(result)}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const done = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await done;
  }
}
