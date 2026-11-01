// Native UI verification using copies of real Mods; no personal files are changed.
import assert from 'node:assert/strict';
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
  access,
} from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd();
const id = randomUUID();
const data = path.join(project, '.native/mod-actions', id);
const output = path.join(project, 'output/playwright/mod-actions', id);
const mods = path.join(data, 'instances', id, 'game/mods');
await mkdir(mods, { recursive: true });
await mkdir(output, { recursive: true });
const sources = [
  path.join(
    project,
    '.native/fixtures/custom-pack-location/fabric-custom-location-final-20261030/instances/43b79d66-fec5-4693-8a77-8333c96cc4a4/game/mods/entityculling-fabric-1.11.2-mc1.21.1.jar',
  ),
  'C:/Users/小萌新一只/AppData/Roaming/.minecraft/versions/落幕曲/mods/jei-1.20.1-forge-15.8.0.11.jar',
  path.join(
    project,
    '.native/fixtures/custom-pack-location/pixelmon-resume-fixed-20261030/instances/4fc390e1-4ae8-491c-9971-9499873950ab/game/mods/jei-1.21.1-neoforge-19.44.0.401.jar',
  ),
];
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const before = await Promise.all(sources.map(hash));
for (const source of sources)
  await copyFile(source, path.join(mods, path.basename(source)));
await writeFile(
  path.join(mods, 'unrecognized.jar'),
  'unrecognized file: preserve',
);
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([
    {
      id,
      name: '模组快捷操作 · 真实 JAR 隔离测试',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
    },
  ]),
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const command = (args) =>
  new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      args,
      { windowsHide: true, timeout: 30000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
let browser;
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {
        timeout: 1000,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  assert(browser, 'Native WebView must be available');
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => console.error('Page error:', error.message));
  await page.locator('.library-instance').first().waitFor();
  const resize = (width, height) =>
    command([
      '-NoProfile',
      '-File',
      path.join(project, 'scripts/resize-native-test-window.ps1'),
      '-AppProcessId',
      String(app.pid),
      '-Width',
      String(width),
      '-Height',
      String(height),
    ]);
  const nav = (name) =>
    page
      .getByRole('navigation')
      .getByRole('button', { name, exact: true })
      .click();
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  const file = path.basename(sources[0]);
  const row = () => page.locator('.content-file-row').filter({ hasText: file });
  await row().waitFor();
  assert.equal(await page.locator('.mod-row-actions').count(), 4);
  for (const source of sources) {
    const item = page
      .locator('.content-file-row')
      .filter({ hasText: path.basename(source) });
    assert(
      (await item.getByTitle('删除模组').count()) ||
        (await item.locator('.mod-delete').count()),
    );
  }
  const power = () => row().getByRole('button', { name: /[启禁]用模组/ });
  assert(await power().isEnabled());
  assert.equal(await page.getByLabel('确认内容修改前游戏已关闭').count(), 0);
  await row()
    .getByRole('button', { name: /查看模组详情/ })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('entityculling', { exact: true }).waitFor();
  await dialog.getByText('Fabric', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'mod-details.png') });
  await dialog.getByRole('button', { name: '关闭弹窗' }).click();
  // Verify actual Explorer selection without listing unrelated personal windows.
  await row()
    .getByRole('button', { name: /打开模组文件位置/ })
    .click();
  const destination = path.join(mods, file).replaceAll("'", "''");
  let selected = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const answer = await command([
      '-NoProfile',
      '-Command',
      `$found=$false; $shell=New-Object -ComObject Shell.Application; foreach($window in $shell.Windows()) { try { foreach($entry in $window.Document.SelectedItems()) { if($entry.Path -eq '${destination}') { $found=$true } } } catch {} }; if($found){'selected'} else {'waiting'}`,
    ]);
    if (answer === 'selected') {
      selected = true;
      break;
    }
    await pause(300);
  }
  assert(selected, 'Explorer must select the exact Mod file');
  await power().click();
  await row()
    .getByRole('button', { name: /启用模组/ })
    .waitFor();
  await access(path.join(mods, file + '.disabled'));
  assert.equal(await hash(path.join(mods, file + '.disabled')), before[0]);
  await power().click();
  await row()
    .getByRole('button', { name: /禁用模组/ })
    .waitFor();
  assert.equal(await hash(path.join(mods, file)), before[0]);
  await row()
    .getByRole('button', { name: /删除模组/ })
    .click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await access(path.join(mods, file));
  await row()
    .getByRole('button', { name: /删除模组/ })
    .click();
  await dialog.getByRole('button', { name: '确认删除模组' }).click();
  await page.getByText(/模组已删除，回收文件/).waitFor();
  assert.equal(await row().count(), 0);
  const trash = path.join(mods, '../.easycraft-mod-trash');
  const archive = path.join(trash, (await readdir(trash))[0]);
  assert.equal(await hash(path.join(archive, file)), before[0]);
  const receipt = JSON.parse(
    await readFile(path.join(archive, 'restore.json'), 'utf8'),
  );
  assert.equal(receipt.file, file);
  const unknown = page
    .locator('.content-file-row')
    .filter({ hasText: 'unrecognized.jar' });
  assert(await unknown.getByRole('button', { name: /删除模组/ }).isDisabled());
  const loaders = [];
  for (const source of sources.slice(1)) {
    const item = page
      .locator('.content-file-row')
      .filter({ hasText: path.basename(source) });
    await item.getByRole('button', { name: /查看模组详情/ }).click();
    const expected = source.includes('neoforge') ? 'NeoForge' : 'Forge';
    await dialog.getByText(expected, { exact: true }).waitFor();
    loaders.push(expected);
    await dialog.getByRole('button', { name: '关闭弹窗' }).click();
  }
  for (const [theme, title] of [
    ['dark', '深板岩夜色'],
    ['light', '草方块亮色'],
  ]) {
    await nav('设置');
    await page.getByRole('button', { name: '个性化', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(title) }).click();
    await nav('游戏库');
    await page.getByRole('tab', { name: '模组', exact: true }).click();
    for (const [width, height] of [
      [1120, 720],
      [900, 600],
    ]) {
      await resize(width, height);
      await page.locator('.mod-row-actions').first().waitFor();
      assert(
        await page
          .locator('.content-manager')
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      for (const button of await page
        .locator('.mod-row-actions')
        .first()
        .getByRole('button')
        .all())
        assert(await button.isVisible());
      await page.screenshot({
        path: path.join(output, `mod-actions-${theme}-${width}.png`),
      });
    }
  }
  await resize(1120, 720);
  await nav('下载');
  await page.getByRole('button', { name: '光影包', exact: true }).click();
  await page.locator('.resource-hit').first().waitFor({ timeout: 90000 });
  const dock = page.locator('.resource-search-dock');
  assert.equal(
    await dock.evaluate((el) => getComputedStyle(el).boxShadow),
    'none',
  );
  const scroll = await dock.evaluate((element) => {
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    )
      if (
        /auto|scroll/.test(getComputedStyle(ancestor).overflowY) &&
        ancestor.scrollHeight > ancestor.clientHeight
      ) {
        ancestor.scrollTop = 550;
        return ancestor.scrollTop;
      }
    throw Error('Missing resource scroll container');
  });
  assert(scroll > 0);
  await pause(200);
  const box = await dock.boundingBox();
  assert(box.y >= 0 && box.y < 200, 'Search controls must remain sticky');
  await page.screenshot({
    path: path.join(output, 'resource-search-sticky.png'),
  });
  assert.deepEqual(
    await Promise.all(sources.map(hash)),
    before,
    'Personal and installed source Mods must be unchanged',
  );
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        data,
        sources,
        loaders,
        realJarCopies: true,
        sourceHashesUnchanged: true,
        disabledAndEnabled: true,
        deleteCancelPreserved: true,
        deletionArchived: true,
        explorerSelected: selected,
        directActionsWithoutCheckbox: true,
        unknownReadOnly: true,
        searchShadow: 'none',
        stickyScroll: scroll,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, passed: true }));
} finally {
  await browser?.close();
  app.kill();
  // The UUID fixture directory cannot belong to a pre-existing Explorer window.
  await command([
    '-NoProfile',
    '-Command',
    `$shell=New-Object -ComObject Shell.Application; foreach($window in $shell.Windows()) { try { if($window.Document.Folder.Self.Path -eq '${mods.replaceAll("'", "''")}') { $window.Quit() } } catch {} }`,
  ]).catch(() => {});
}
