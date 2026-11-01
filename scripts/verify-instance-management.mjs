// Owned synthetic fixtures only: never rename, remove or move a personal instance.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd();
const data = path.join(project, '.native/instance-management', randomUUID());
const output = path.join(project, 'output/playwright/instance-management');
const source = path.join(
  project,
  '.native/fixtures/instance-management',
  randomUUID(),
);
await mkdir(output, { recursive: true });
const item = {
  id: randomUUID(),
  name: '实例管理测试',
  version: '1.21.1',
  manifestSha1: 'a'.repeat(40),
  javaMajor: 21,
  fabricVersion: '',
  fabricSha1: '',
};
const external = {
  ...item,
  id: randomUUID(),
  name: '引用的本地版本',
  local: {
    root: source,
    versionDirectory: 'versions/ref',
    gameDirectory: 'versions/ref',
    clientJar: 'versions/ref/ref.jar',
    sourceKey: 'b'.repeat(64),
    loader: 'vanilla',
    loaderVersion: '',
  },
};
const ownedFile = path.join(data, 'instances', item.id, 'game/saves/keep.txt');
const sourceFile = path.join(source, 'versions/ref/keep.txt');
await mkdir(path.dirname(ownedFile), { recursive: true });
await mkdir(path.dirname(sourceFile), { recursive: true });
await writeFile(ownedFile, 'owned synthetic world');
for (const name of [
  '海岛生存 · 测试存档',
  '超长名称的本地存档用于验证缩窄布局不会溢出',
  '创造模式测试',
]) {
  const directory = path.join(path.dirname(ownedFile), name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'level.dat'),
    gzipSync(Buffer.from([10, 0, 0, 10, 0, 4, 68, 97, 116, 97, 0, 0])),
  );
}
await writeFile(sourceFile, 'external synthetic world');
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([item, external]),
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const app = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
    stdio: 'ignore',
  },
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
  page.setDefaultTimeout(20000);
  await page.locator('.library-instance').first().waitFor();
  const command = (args) =>
    new Promise((ok, fail) =>
      execFile(
        'powershell.exe',
        args,
        { windowsHide: true, timeout: 30000 },
        (error) => (error ? fail(error) : ok()),
      ),
    );
  const resize = (w, h) =>
    command([
      '-NoProfile',
      '-File',
      path.join(project, 'scripts/resize-native-test-window.ps1'),
      '-AppProcessId',
      String(app.pid),
      '-Width',
      String(w),
      '-Height',
      String(h),
    ]);
  const nav = (name) =>
    page
      .getByRole('navigation')
      .getByRole('button', { name, exact: true })
      .click();
  for (const [theme, title] of [
    ['dark', '深板岩夜色'],
    ['light', '草方块亮色'],
  ]) {
    await nav('设置');
    await page.getByRole('button', { name: '个性化', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await nav('游戏库');
    for (const [width, height] of [
      [1120, 720],
      [900, 600],
    ]) {
      await resize(width, height);
      await page.getByRole('heading', { name: '本地存档' }).waitFor();
      for (const name of [
        '游戏文件夹',
        '模组文件夹',
        '存档文件夹',
        '截图文件夹',
        '资源包文件夹',
        '光影包文件夹',
        '重命名',
        '移除实例',
      ])
        assert.equal(
          await page.getByRole('button', { name, exact: true }).count(),
          1,
        );
      assert.equal(
        await page.getByText('更多文件夹', { exact: true }).count(),
        0,
      );
      assert(
        (await page.locator('.overview-hero').boundingBox()).height <= 160,
      );
      assert.equal(
        await page.locator('.overview-world-list button').count(),
        3,
      );
      await page.screenshot({
        path: path.join(output, `overview-${theme}-${width}.png`),
        animations: 'disabled',
      });
      assert(
        await page
          .locator('.overview-world-list')
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        'Long world name must remain inside its card',
      );
    }
  }
  await resize(1120, 720);
  const status = () =>
    page.evaluate(() => window.__TAURI_INTERNALS__.invoke('native_status'));
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '重命名实例' });
  await rename.getByLabel('真实实例名称').fill('重新命名 · 管理测试');
  await rename.getByRole('button', { name: '保存实例名称' }).click();
  await page
    .getByRole('button', { name: /重新命名 · 管理测试/ })
    .first()
    .waitFor();
  assert.equal((await status()).instances[0].name, '重新命名 · 管理测试');
  await page
    .getByRole('button', { name: '管理实例 重新命名 · 管理测试', exact: true })
    .click();
  await page.screenshot({ path: path.join(output, '01-menu.png') });
  await page.getByRole('menuitem', { name: '移除实例', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '移除实例', exact: true });
  assert(await dialog.getByRole('checkbox').isChecked());
  await page.screenshot({ path: path.join(output, '02-confirm-owned.png') });
  await page.keyboard.press('Escape');
  assert.equal((await status()).instances.length, 2);
  assert.equal(await readFile(ownedFile, 'utf8'), 'owned synthetic world');
  await page.getByRole('button', { name: '移除实例', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '移除实例', exact: true });
  await dialog.getByRole('button', { name: '确认移除' }).click();
  for (let i = 0; i < 100 && (await status()).instances.length !== 1; i++)
    await pause(100);
  assert.equal((await status()).instances.length, 1);
  assert(
    !(await access(ownedFile).then(
      () => true,
      () => false,
    )),
  );
  const reference = page.locator('.library-instance').first();
  await reference.focus();
  await reference.press('Delete');
  dialog = page.getByRole('dialog', { name: '移除实例', exact: true });
  assert.equal(await dialog.getByRole('checkbox').count(), 1);
  await dialog.getByRole('checkbox').uncheck();
  await page.screenshot({
    path: path.join(output, '03-confirm-reference.png'),
  });
  await dialog.getByRole('button', { name: '确认移除' }).click();
  for (let i = 0; i < 100 && (await status()).instances.length; i++)
    await pause(100);
  assert.equal((await status()).instances.length, 0);
  assert.equal(await readFile(sourceFile, 'utf8'), 'external synthetic world');
  await page.reload();
  await page.locator('.library-empty').waitFor();
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        data,
        renamePersisted: true,
        cancelPreserved: true,
        ownedDataRecycled: true,
        referencedDataPreserved: true,
        emptyLibraryPersists: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  app.kill();
}
