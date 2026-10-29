import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readdir, copyFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const output = path.join(project, 'output/playwright/ui-redesign');
const data = path.join(project, '.native/ui-redesign', randomUUID());
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const settings = {
  clientId: '',
  javaPath: '',
  memoryMb: 2048,
  memoryMode: 'auto',
  optimizeMemory: false,
  launchMode: 'offline',
  offlineName: 'UIReview',
};
await writeFile(path.join(data, 'settings.json'), JSON.stringify(settings));
await writeFile(path.join(data, 'instances.json'), '[]');
let child, browser, page, originalPreferences;
const errors = [];
const measurements = {};
const executable = path.join(project, 'src-tauri/target/debug/easy-craft.exe');
async function start() {
  child = spawn(executable, [], {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure = '';
  child.stderr.on('data', (chunk) => {
    failure = (failure + chunk).slice(-8000);
  });
  for (let attempt = 0; attempt < 40; attempt++) {
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
  assert(browser, 'No desktop debugging endpoint');
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.library-shell').waitFor();
  if (originalPreferences === undefined)
    originalPreferences = await page.evaluate(() =>
      localStorage.getItem('easycraft.preferences.v1'),
    );
  await page.evaluate(() => {
    const previous = JSON.parse(
      localStorage.getItem('easycraft.preferences.v1') ?? '{}',
    );
    localStorage.setItem(
      'easycraft.preferences.v1',
      JSON.stringify({
        selectedId: '',
        doubleClickLaunch: false,
        developerEnabled: false,
        sort: 'recent',
        ...previous,
        theme: 'slate',
        sidebarWidth: 240,
        layout: 'default',
        uiScale: 100,
        accentColor: undefined,
        navigation: {
          section: 'library',
          settingsCategory: 'launch',
          downloadCategory: 'vanilla',
          instanceTabs: {},
          query: '',
          scroll: {},
        },
      }),
    );
  });
  await page.reload();
  await page.locator('.library-shell').waitFor();
}
async function stop() {
  if (page && !page.isClosed() && originalPreferences !== undefined) {
    await page
      .evaluate((value) => {
        if (value === null) localStorage.removeItem('easycraft.preferences.v1');
        else localStorage.setItem('easycraft.preferences.v1', value);
      }, originalPreferences)
      .catch(() => {});
  }
  const desktop = child;
  await browser?.close();
  browser = undefined;
  if (desktop && desktop.exitCode === null) {
    const exited = new Promise((resolve) => desktop.once('exit', resolve));
    desktop.kill();
    await exited;
  }
  child = undefined;
}
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const nav = (name) =>
  page
    .getByRole('navigation')
    .getByRole('button', { name, exact: true })
    .click();
const shot = (name) =>
  page.screenshot({
    path: path.join(output, `${name}.png`),
    animations: 'disabled',
  });
async function resize(width, height) {
  await new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
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
      ],
      { windowsHide: true, timeout: 15000 },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
async function appearance(theme) {
  await nav('设置');
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(theme) }).click();
}
try {
  await start();
  await page.getByRole('button', { name: '安装游戏', exact: true }).waitFor();
  await shot('01-empty-dark');
  assert.equal(
    await page.getByRole('tablist', { name: '实例工作区' }).count(),
    0,
  );
  await nav('下载');
  const install = page.getByRole('button', {
    name: '下载并安装原版',
    exact: true,
  });
  await install.waitFor();
  const installBox = await install.boundingBox();
  const height = await page.evaluate(() => innerHeight);
  assert(
    installBox.y + installBox.height < height - 32,
    'Installation action below first screen',
  );
  measurements.installBottom = installBox.y + installBox.height;
  measurements.viewportHeight = height;
  const versionBox = await page
    .getByRole('combobox', { name: '原版版本', exact: true })
    .boundingBox();
  const loaderBox = await page
    .getByLabel('真实实例加载器', { exact: true })
    .boundingBox();
  assert(
    Math.abs(versionBox.y - loaderBox.y) <= 1 &&
      Math.abs(versionBox.height - loaderBox.height) <= 1,
    'Install controls are not aligned',
  );
  await shot('02-install');
  for (const name of ['模组', '光影包', '整合包', '数据包', '资源包']) {
    await page
      .locator('.context-category-list')
      .getByRole('button', { name, exact: true })
      .click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await shot(`03-download-${name}`);
  }
  await nav('扩展');
  await page.getByRole('button', { name: '紧凑工作区', exact: true }).click();
  assert.equal(
    await page.locator('.native-library').getAttribute('data-layout'),
    'compact',
  );
  await page
    .getByRole('button', { name: '恢复默认布局与栏宽', exact: true })
    .click();
  await shot('04-extensions');
  for (const name of ['启动', '个性化', '下载设置', '其他']) {
    await nav('设置');
    await page
      .locator('.context-category-list')
      .getByRole('button', { name, exact: true })
      .click();
    assert.equal(
      await page.getByText('下载设置设置', { exact: true }).count(),
      0,
    );
    await shot(`05-settings-${name}`);
  }
  await page.getByRole('button', { name: '管理游戏账户', exact: true }).click();
  await page.getByRole('button', { name: '正版登录', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: '打开微软官方登录网站', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByLabel('Microsoft 应用 Client ID', { exact: true })
      .isVisible(),
    false,
  );
  await shot('06-account');
  await page.keyboard.press('Escape');
  await nav('游戏库');
  await stop();

  // Synthetic local fixtures: no Minecraft launch, network installation or user data changes.
  const id = randomUUID();
  const longId = randomUUID();
  const fixture = {
    id,
    name: '轻量生存 · UI 验收样例',
    version: '1.21.1',
    manifestSha1: 'a'.repeat(40),
    javaMajor: 21,
    fabricVersion: '0.16.14',
    fabricSha1: 'b'.repeat(40),
  };
  await writeFile(
    path.join(data, 'instances.json'),
    JSON.stringify([
      fixture,
      {
        ...fixture,
        id: longId,
        name: ('长名称验收样例 · ' + '山谷中的世界'.repeat(10)).slice(0, 60),
      },
    ]),
  );
  const game = path.join(data, 'instances', id, 'game');
  await mkdir(path.join(game, 'mods'), { recursive: true });
  await mkdir(path.join(game, 'saves', '山谷里的家'), { recursive: true });
  await mkdir(path.join(data, 'instances', longId, 'game'), {
    recursive: true,
  });
  await copyFile(
    path.join(project, '.native/fixtures/world/level.dat'),
    path.join(game, 'saves/山谷里的家/level.dat'),
  );
  let modFixture;
  for (const folder of await readdir(
    path.join(project, '.native/resource-install-tests'),
  )) {
    const candidate = path.join(
      project,
      '.native/resource-install-tests',
      folder,
      'mods/example.jar',
    );
    try {
      await access(candidate);
      modFixture = candidate;
      break;
    } catch {
      /* Other isolated test cases. */
    }
  }
  assert(
    modFixture,
    'Run native unit tests first to create the dependency fixture',
  );
  await copyFile(modFixture, path.join(game, 'mods/example.jar'));
  await start();
  await nav('游戏库');
  await page
    .getByRole('heading', { name: fixture.name, exact: true })
    .waitFor();
  await page.locator('.preflight-summary.has-warning').waitFor();
  const check = await invoke('native_mod_check', { id });
  assert(check.issues.some((message) => message.includes('missing_lib')));
  assert.equal((await invoke('native_status')).task.status, 'idle');
  await shot('07-instance-dark-fixture');
  await page.getByRole('tab', { name: '概览', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await page
      .getByRole('tab', { name: '模组', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await page.keyboard.press('Home');
  assert.equal(
    await page
      .getByRole('tab', { name: '概览', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await page.locator('.preflight-summary').click();
  assert(
    await page
      .getByRole('button', { name: '仍然启动', exact: true })
      .isEnabled(),
  );
  assert.equal(
    await page.getByRole('button', { name: '一键修复', exact: true }).count(),
    0,
  );
  await shot('08-preflight-fixture');
  await page.keyboard.press('Escape');
  for (const tab of ['模组', '资源与光影', '存档', '截图', '实例设置']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await shot(`09-instance-${tab}-fixture`);
  }
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await resize(800, 540);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await shot('10-minimum-fixture');
  await resize(1120, 720);
  await appearance('草方块亮色');
  await nav('游戏库');
  await shot('11-instance-light-fixture');
  await page.locator('.library-instance').nth(1).click();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await shot('12-long-name-fixture');
  assert.equal((await invoke('native_status')).task.status, 'idle');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        result: 'passed',
        source:
          'actual debug exe with isolated synthetic local fixtures; no game launched',
        data,
        measurements,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ result: 'passed', output, measurements }));
} finally {
  await stop();
}
