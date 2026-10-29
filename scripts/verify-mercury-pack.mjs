// Authorized real Mod metadata, read-only source and isolated launcher data. No game launch.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdir,
  writeFile,
  readdir,
  readFile,
  copyFile,
  access,
  cp,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const data =
  process.env.EASYCRAFT_MERCURY_INSTALL_ROOT ||
  path.join(project, '.native/mercury-reinstall');
assert(path.resolve(data).startsWith(path.join(project, '.native') + path.sep));
const output = path.join(project, 'output/playwright/mercury-reinstall');
assert(
  !(await access(data).then(
    () => true,
    () => false,
  )),
  'Fresh installation test requires a new, empty data root',
);
await mkdir(data, { recursive: true });
if (process.env.EASYCRAFT_MERCURY_CACHE) {
  const cache = path.resolve(process.env.EASYCRAFT_MERCURY_CACHE);
  assert(cache.startsWith(project + path.sep));
  for (const name of [
    'assets',
    'libraries',
    'versions',
    'downloads',
    'pack-cache',
  ])
    await cp(path.join(cache, name), path.join(data, name), {
      recursive: true,
    });
}
await mkdir(output, { recursive: true });
const downloadRoot = path.join(process.env.USERPROFILE, 'Downloads');
const archive = (await readdir(downloadRoot)).find(
  (name) => name === '[Mercury landing-水星迫降]-7.0b+8.zip',
);
assert(archive);
const bytes = await readFile(path.join(downloadRoot, archive));
const fixture = path.join(project, '.native/fixtures/mercury-reinstall.zip');
await mkdir(path.dirname(fixture), { recursive: true });
await copyFile(path.join(downloadRoot, archive), fixture);
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
  await page.locator('.library-shell').waitFor();
  await resize(1120, 720);
  page.setDefaultTimeout(60000);
  await page.locator('.library-import-link').click();
  await command('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-File',
    fixture,
  ]);
  const dialog = page.getByRole('dialog', { name: '导入本地整合包' });
  const nameInput = dialog.getByLabel('整合包新实例名称');
  await nameInput.waitFor();
  await shot('00-import-dark');
  await resize(900, 600);
  await shot('00-import-small');
  await resize(1120, 720);
  // Cancelling a replacement file picker must keep the ready-to-install preview.
  await dialog.getByRole('button', { name: /从电脑选择/ }).click();
  await command('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Cancel',
  ]);
  await nameInput.waitFor();
  await nameInput.fill('水星迫降重置版 · 全新安装验证');
  await dialog.getByRole('button', { name: '确认变更并安装整合包' }).click();
  await page.getByRole('dialog', { name: '任务与日志' }).waitFor();
  await page.keyboard.press('Escape');
  let previous = '';
  for (let i = 0; i < 1800; i++) {
    const state = await invoke('native_status');
    if (state.task.message !== previous) {
      console.log(JSON.stringify(state.task));
      previous = state.task.message;
    }
    if (i === 3) {
      await shot('01-pending');
      await page.locator('.pending-install').click();
      await shot('01-step-progress');
      await page.keyboard.press('Escape');
    }
    if (state.task.status !== 'running') {
      await writeFile(
        path.join(output, 'result.json'),
        JSON.stringify(state, null, 2),
      );
      await shot('02-result');
      assert.equal(state.task.status, 'succeeded', state.task.message);
      const instance = state.instances.find((item) =>
        item.name.includes('水星'),
      );
      assert(instance);
      await page
        .locator('.library-instance:not(.pending-install)')
        .filter({ hasText: '水星' })
        .waitFor();
      await shot('03-installed-library');
      assert((await readFile(path.join(downloadRoot, archive))).equals(bytes));
      assert(
        !(await access(path.join(data, 'pack-recovery')).then(
          () => true,
          () => false,
        )),
        'Manual recovery receipts must not be needed',
      );
      assert.equal(state.task.pid, null);
      const game = path.join(data, 'instances', instance.id, 'game');
      const provenance = JSON.parse(
        await readFile(path.join(game, '.easycraft-pack.json'), 'utf8'),
      );
      assert.equal(provenance.files.length, 802);
      const recovered = await readFile(
        path.join(game, 'mods/lootbags-2.5.8.7.jar'),
      );
      assert.equal(
        createHash('sha1').update(recovered).digest('hex'),
        '762294ef3baf7a09d9d875e6218895fa51b89d43',
      );
      await writeFile(
        path.join(output, 'verification.json'),
        JSON.stringify(
          {
            freshDataRoot: true,
            manualRecoveryDirectory: false,
            files: provenance.files.length,
            recoveredFileSha1: createHash('sha1')
              .update(recovered)
              .digest('hex'),
            sourceArchiveUnchanged: true,
          },
          null,
          2,
        ),
      );
      console.log('INSTALLED ' + instance.id);
      break;
    }
    await pause(1000);
    if (i === 1799) throw Error('Install timeout; inspect task');
  }
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
