// Actual WebView2 UI: pack dialog, sticky return, system folder selection/cancel.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readdir, link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
const project = process.cwd();
const id = randomUUID();
const data = path.join(project, '.native/pack-ui', id);
const output = path.join(project, 'output/playwright/pack-ui', id);
const destination = path.join(project, '.native/fixtures/pack-ui', id);
for (const directory of [
  data,
  output,
  destination,
  path.join(data, 'pack-archives'),
])
  await mkdir(directory, { recursive: true });
await writeFile(path.join(data, 'instances.json'), '[]');
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: '',
    memoryMb: 4096,
    memoryMode: 'manual',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'UITest',
    isolateNewInstances: true,
  }),
);
const archives = path.join(
  project,
  'src-tauri/target/debug/data/pack-archives',
);
for (const file of await readdir(archives))
  if (file.endsWith('.mrpack'))
    await link(
      path.join(archives, file),
      path.join(data, 'pack-archives', file),
    );
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const app = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
  },
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (cancel = false) =>
  new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        path.join(project, 'scripts/select-native-file.ps1'),
        '-AppProcessId',
        String(app.pid),
        ...(cancel ? ['-Cancel'] : ['-File', destination, '-Directory']),
      ],
      { windowsHide: true, timeout: 60000 },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {
        timeout: 1000,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.locator('.library-shell').waitFor();
  await page.getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('button', { name: '整合包', exact: true }).click();
  await page.getByLabel('搜索在线资源').fill('Pixelmon');
  await page.getByRole('button', { name: '搜索资源', exact: true }).click();
  await page
    .getByRole('button', { name: '查看 The Pixelmon Modpack', exact: true })
    .click({ timeout: 30000 });
  await page
    .locator('.resource-version-list')
    .first()
    .waitFor({ timeout: 30000 });
  assert.equal(
    await page.getByText('声明的依赖与冲突', { exact: true }).count(),
    0,
  );
  assert.equal(await page.locator('.pack-inspector').count(), 0);
  const scroll = await page.locator('.resource-detail').evaluate((element) => {
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (
        /auto|scroll/.test(getComputedStyle(ancestor).overflowY) &&
        ancestor.scrollHeight > ancestor.clientHeight
      ) {
        ancestor.scrollTop = ancestor.scrollHeight;
        return { height: ancestor.scrollHeight, position: ancestor.scrollTop };
      }
    }
    throw Error('Download page scroll container not found');
  });
  await pause(250);
  const back = await page
    .getByRole('button', { name: '返回搜索结果', exact: true })
    .boundingBox();
  assert(back && back.y >= 0 && back.y < 160, JSON.stringify(back));
  await page.screenshot({ path: path.join(output, 'sticky-return-1120.png') });
  await page
    .getByRole('button', { name: /The Pixelmon Modpack 9\.4\.2/ })
    .click();
  const dialog = page.getByRole('dialog', { name: /安装整合包/ });
  await dialog.waitFor();
  await dialog
    .getByRole('button', { name: '下载此版本并检查整合包', exact: true })
    .click();
  await dialog.getByLabel('整合包新实例名称').waitFor({ timeout: 60000 });
  assert((await dialog.textContent()).includes('NeoForge 21.1.248'));
  await dialog.getByRole('button', { name: '更改位置', exact: true }).click();
  await pick(true);
  await dialog.getByRole('button', { name: '更改位置', exact: true }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.pack-destination button')?.disabled,
  );
  assert(!(await dialog.textContent()).includes(destination));
  await dialog.getByRole('button', { name: '更改位置', exact: true }).click();
  await pick();
  await dialog.getByText(destination, { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'pack-location-1120.png') });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.screenshot({ path: path.join(output, 'pack-location-900.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '返回搜索结果', exact: true }).click();
  await page.getByLabel('搜索在线资源').waitFor();
  const state = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('native_status'),
  );
  assert.equal(
    state.instances.length,
    0,
    'UI preview must not silently install a pack',
  );
  assert.equal(state.task.status, 'succeeded');
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        stickyBack: back,
        scroll,
        folderPickerCancel: true,
        folderPickerSelect: true,
        dialogEscape: true,
        previewDoesNotInstall: true,
        destination,
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  await browser?.close().catch(() => {});
  app.kill();
}
