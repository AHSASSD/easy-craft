// Real native folder picker and archive export; isolated library remains empty.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const project = process.cwd(),
  run = randomUUID();
const data = path.join(project, '.native/pack-save', run),
  destination = path.join(project, '.native/fixtures/pack-save', run),
  output = path.join(project, 'output/playwright/pack-save', run);
for (const p of [data, destination, output])
  await mkdir(p, { recursive: true });
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const app = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      EASYCRAFT_NETWORK_DIRECT: '1',
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  },
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const picker = (cancel = false) =>
  new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        'scripts/select-native-file.ps1',
        '-AppProcessId',
        String(app.pid),
        ...(cancel ? ['-Cancel'] : ['-File', destination, '-Directory']),
      ],
      { windowsHide: true, timeout: 60000 },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
let browser, page;
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
  page.setDefaultTimeout(90000);
  await page.locator('.library-shell').waitFor();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page.getByRole('button', { name: '整合包', exact: true }).click();
  await page.getByLabel('搜索在线资源').fill('红石生电优化');
  await page.getByRole('button', { name: '搜索资源', exact: true }).click();
  await page
    .locator('.resource-hit')
    .filter({ hasText: 'Redstone Survival Optimization' })
    .first()
    .locator('.resource-row-open')
    .click();
  await page.locator('.resource-version-catalog').waitFor();
  const group = page
    .locator('.resource-game-group')
    .filter({ has: page.getByRole('button', { name: /Minecraft 26.2 / }) });
  const toggle = group.getByRole('button', { name: /Minecraft 26.2 / });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await group
    .getByRole('button')
    .filter({ hasText: '26.2-5.8' })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: '仅下载整合包归档' }).check();
  await expect(dialog.getByRole('textbox', { name: '实例名称' })).toHaveCount(
    0,
  );
  await dialog
    .getByRole('button', { name: '选择文件夹并下载', exact: true })
    .click();
  await picker(true);
  await expect(
    dialog.getByRole('button', { name: '选择文件夹并下载', exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole('button', { name: '选择文件夹并下载', exact: true })
    .click();
  await picker();
  await expect(dialog.getByRole('status')).toContainText('未创建游戏实例', {
    timeout: 180000,
  });
  const versions = JSON.parse(
    (await readFile('output/rso-versions.json', 'utf8')).replace(/^\ufeff/, ''),
  );
  const file = versions[0].files[0];
  const saved = await readFile(path.join(destination, file.filename));
  assert.equal(
    createHash('sha512').update(saved).digest('hex'),
    file.hashes.sha512,
  );
  const state = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('native_status'),
  );
  assert.equal(state.instances.length, 0);
  await page.screenshot({ path: path.join(output, 'archive-only.png') });
  await dialog
    .getByRole('button', { name: '选择文件夹并下载', exact: true })
    .click();
  await picker();
  await expect(dialog.getByRole('alert')).toContainText('同名文件');
  assert.equal(
    createHash('sha512')
      .update(await readFile(path.join(destination, file.filename)))
      .digest('hex'),
    file.hashes.sha512,
  );
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        destination,
        archive: file.filename,
        sha512: file.hashes.sha512,
        instances: 0,
        cancel: true,
        noOverwrite: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, output, destination }));
} catch (e) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  if (page)
    console.error((await page.locator('body').innerText()).slice(-2200));
  throw e;
} finally {
  await browser?.close();
  app.kill();
}
