// Authorized real Mod metadata, read-only source and isolated launcher data. No game launch.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const data = path.join(project, '.native/resource-target-test');
const output = path.join(project, 'output/playwright/resource-target');
await mkdir(data, { recursive: true });
await mkdir(output, { recursive: true });
const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const shot = (name) =>
  page.screenshot({
    path: path.join(output, name + '.png'),
    animations: 'disabled',
  });
async function resize(width, height, capture) {
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
    ...(capture ? ['-Screenshot', path.join(output, capture + '.png')] : []),
  ]);
}
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(60000);
  await page.locator('.library-shell').waitFor();
  await resize(1120, 720);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page.getByRole('button', { name: '数据包', exact: true }).click();
  await page.getByLabel('搜索在线资源').fill('Veinminer');
  await page.getByRole('button', { name: '搜索资源', exact: true }).click();
  await page.locator('.resource-row-open').first().click();
  await page.locator('.resource-version-list button').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await shot('01-install-target');
  await dialog.getByRole('radio', { name: '仅保存到文件夹' }).check();
  await shot('02-save-only');
  await dialog.getByRole('button', { name: '选择文件夹并保存' }).click();
  await command('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Cancel',
  ]);
  await dialog.getByRole('button', { name: '选择文件夹并保存' }).waitFor();
  const folder = path.join(
    project,
    '.native/fixtures/resource-export-' + Date.now(),
  );
  await mkdir(folder, { recursive: true });
  const before = new Set(await readdir(folder));
  await dialog.getByRole('button', { name: '选择文件夹并保存' }).click();
  await command('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Directory',
    '-File',
    folder,
  ]);
  await dialog.getByText('资源已保存到所选文件夹，尚未安装或启用。').waitFor();
  const added = (await readdir(folder)).filter((file) => !before.has(file));
  assert.equal(added.length, 1);
  assert(added[0].endsWith('.zip'));
  await shot('03-saved');
  const status = await invoke('native_status');
  assert.equal(status.task.status, 'succeeded');
  assert.equal(status.task.phase, 'resource-export-committed');
  assert.equal(status.task.message, '资源已保存；尚未安装或启用');
  assert.equal(status.instances.length, 0);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        folder,
        file: added[0],
        task: status.task,
        cancelledPicker: true,
        noInstancesInstalled: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
