// Native UI verification; synthetic NBT only, no personal saves or accounts.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd(),
  id = randomUUID();
const data = path.join(project, '.native/world-resource-ui', id);
const output = path.join(project, 'output/playwright/world-resource-ui', id);
const game = path.join(data, 'instances', id, 'game');
const world = path.join(game, 'saves/Test World');
await mkdir(world, { recursive: true });
await mkdir(output, { recursive: true });
const str = (value) => {
  const bytes = Buffer.from(value);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
};
const tag = (type, name, bytes) =>
  Buffer.concat([Buffer.from([type]), str(name), bytes]);
const int = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
const raw = Buffer.concat([
  Buffer.from([10, 0, 0]),
  tag(
    10,
    'Data',
    Buffer.concat([
      ...[
        ['Difficulty', 2],
        ['DifficultyLocked', 0],
        ['allowCommands', 0],
        ['hardcore', 0],
        ['raining', 0],
        ['thundering', 0],
      ].map(([name, value]) => tag(1, name, Buffer.from([value]))),
      tag(3, 'GameType', int(0)),
      tag(3, 'DataVersion', int(3955)),
      tag(8, 'LevelName', str('界面验证世界')),
      tag(
        10,
        'GameRules',
        Buffer.concat([
          tag(8, 'keepInventory', str('false')),
          Buffer.from([0]),
        ]),
      ),
      Buffer.from([0]),
    ]),
  ),
  Buffer.from([0]),
]);
const original = gzipSync(raw);
await writeFile(path.join(world, 'level.dat'), original);
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([
    {
      id,
      name: '存档界面测试',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
    },
  ]),
);
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const app = spawn(
  process.env.EASYCRAFT_UI_TEST_BINARY ??
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const command = (args) =>
  new Promise((resolve, reject) =>
    execFile('powershell.exe', args, { windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
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
  page.setDefaultTimeout(25000);
  await page
    .locator('.library-instance')
    .first()
    .waitFor()
    .catch(async (error) => {
      await page.screenshot({ path: path.join(output, 'startup-failure.png') });
      console.error(
        'STARTUP',
        page.url(),
        (await page.locator('body').innerText()).slice(0, 1500),
      );
      throw error;
    });
  const resize = (width, height) =>
    command([
      '-NoProfile',
      '-File',
      path.join(project, 'scripts/resize-native-test-window.ps1'),
      '-AppProcessId',
      String(app.pid),
      '-BinaryName',
      path.basename(
        process.env.EASYCRAFT_UI_TEST_BINARY ?? 'easy-craft.exe',
        '.exe',
      ),
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
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  await nav('设置');
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await nav('游戏库');
  await resize(1120, 720);
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  const difficulty = page.getByLabel('世界难度');
  await difficulty.waitFor();
  assert.equal(await page.getByLabel('确认游戏已关闭').count(), 0);
  const save = page.getByRole('button', { name: '保存世界设置', exact: true });
  assert(await save.isEnabled());
  await difficulty.selectOption('1');
  await save.click();
  await page
    .getByRole('status')
    .filter({ hasText: '已保存，原文件已备份' })
    .waitFor();
  const saved = await invoke('native_world', { id, worldId: 'Test World' });
  assert.equal(saved.difficulty, 1);
  const backups = await invoke('native_config_backups', {
    id,
    worldId: 'Test World',
  });
  assert(backups.entries.length > 0);
  assert(
    backups.entries.some(
      (entry) =>
        entry.sha1 === createHash('sha1').update(original).digest('hex'),
    ),
  );
  assert.notDeepEqual(await readFile(path.join(world, 'level.dat')), original);
  for (const [width, height] of [
    [1120, 720],
    [900, 600],
  ]) {
    await resize(width, height);
    await page.screenshot({
      path: path.join(output, `world-direct-${width}.png`),
    });
  }
  await resize(1120, 720);
  await page.getByRole('tab', { name: '实例设置', exact: true }).click();
  const volume = page.getByLabel('主音量');
  await volume.waitFor();
  await volume.focus();
  await volume.press('Home');
  await volume.press('ArrowRight');
  for (let i = 0; i < 40; i++) {
    const options = await invoke('native_options', { id });
    if (options.masterVolume === 0.01) break;
    await pause(150);
  }
  assert.equal((await invoke('native_options', { id })).masterVolume, 0.01);
  await page.getByLabel('音乐音量').focus();
  await page.getByLabel('音乐音量').press('Home');
  await nav('扩展');
  assert.equal(
    await page
      .getByRole('button', { name: '我的工具', exact: true })
      .getAttribute('aria-expanded'),
    'true',
  );
  await page.screenshot({
    path: path.join(output, 'accordion-default-1120.png'),
  });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal((await invoke('native_options', { id })).musicVolume, 0);
  await page
    .getByLabel('导入本地插件')
    .setInputFiles(path.join(project, 'docs/plugins/compact.ecplugin.json'));
  await page
    .getByRole('heading', { name: '轻巧工作区', exact: true })
    .waitFor();
  await page.getByRole('switch', { name: '启用', exact: true }).click();
  for (
    let i = 0;
    i < 30 &&
    (await page.locator('.native-library').getAttribute('data-layout')) !==
      'compact';
    i++
  )
    await pause(100);
  assert.equal(
    await page.locator('.native-library').getAttribute('data-layout'),
    'compact',
  );
  await page.getByRole('button', { name: '我的工具', exact: true }).click();
  await page
    .getByRole('heading', { name: '轻巧工作区', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '实例扩展', exact: true }).click();
  assert.equal(
    await page.locator('.extension-groups button[aria-expanded=true]').count(),
    1,
  );
  await page.getByRole('button', { name: /^界面外观/ }).click();
  await pause(250);
  await page.screenshot({ path: path.join(output, 'extensions-local.png') });
  await resize(900, 600);
  await page.screenshot({ path: path.join(output, 'accordion-900.png') });
  await resize(1120, 720);
  await page.reload();
  await page.locator('.library-shell').waitFor();
  await nav('扩展');
  await page.getByRole('button', { name: /^界面外观/ }).click();
  await page.getByRole('button', { name: /^轻巧工作区/ }).click();
  await page
    .getByRole('heading', { name: '轻巧工作区', exact: true })
    .waitFor();
  await nav('游戏库');
  await page.getByRole('tab', { name: '实例设置', exact: true }).click();
  await page.getByLabel('主音量').waitFor();
  await page.screenshot({ path: path.join(output, 'audio-autosave-1120.png') });
  await resize(900, 600);
  await page.screenshot({ path: path.join(output, 'audio-autosave-900.png') });
  await resize(1120, 720);
  await nav('下载');
  await page.getByRole('button', { name: '资源包', exact: true }).click();
  await page.getByLabel('搜索在线资源').fill('Fresh Animations');
  await page.getByRole('button', { name: '搜索资源', exact: true }).click();
  await page
    .getByRole('button', { name: '查看 Fresh Animations', exact: true })
    .click({ timeout: 60000 });
  await page.locator('.resource-version-catalog').waitFor({ timeout: 60000 });
  const measurements = await page
    .locator('.resource-detail-nav')
    .evaluate((nav) => {
      const button = nav.querySelector('button').getBoundingClientRect();
      const card = document
        .querySelector('.resource-detail')
        .getBoundingClientRect();
      const intro = document
        .querySelector('.resource-project-description')
        .getBoundingClientRect();
      const catalog = document
        .querySelector('.resource-version-catalog')
        .getBoundingClientRect();
      return {
        inset: button.left - card.left,
        gap: catalog.top - intro.bottom,
      };
    });
  assert(measurements.inset >= 15 && measurements.inset <= 18);
  assert(measurements.gap >= 23);
  await page.locator('.resource-project-description > summary').click();
  await page.screenshot({
    path: path.join(output, 'resource-detail-expanded.png'),
  });
  await page.locator('.resource-project-description > summary').click();
  await page.screenshot({
    path: path.join(output, 'resource-detail-1120.png'),
  });
  await page.locator('.resource-detail').evaluate((el) => {
    for (let p = el.parentElement; p; p = p.parentElement)
      if (
        /auto|scroll/.test(getComputedStyle(p).overflowY) &&
        p.scrollHeight > p.clientHeight
      ) {
        p.scrollTop = p.scrollHeight;
        return;
      }
    throw Error('Missing scroll container');
  });
  const back = page.getByRole('button', { name: '返回搜索结果', exact: true });
  const box = await back.boundingBox();
  assert(box.y >= 0 && box.y < 200);
  await back.click();
  await page.locator('.resource-hit').first().waitFor();
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        data,
        syntheticWorld: true,
        directSave: true,
        backupCount: backups.entries.length,
        measurements,
        stickyBack: true,
        files: await readdir(world),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  await browser?.close();
  app.kill();
}
