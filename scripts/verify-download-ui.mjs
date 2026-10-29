import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const output = path.join(project, 'output/playwright/download-ui');
const testRoot = path.join(project, '.native/download-ui');
const data =
  process.env.EASYCRAFT_DOWNLOAD_TEST_DATA ?? path.join(testRoot, randomUUID());
assert(
  path.resolve(data).startsWith(path.resolve(testRoot) + path.sep),
  'Only this harness isolated data can be reused',
);
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
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
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
try {
  await start();
  await resize(1120, 720);
  await nav('下载');
  await page
    .locator('.official-version-list > button')
    .first()
    .waitFor({ timeout: 60000 });
  const catalog = await invoke('native_version_catalog');
  assert(catalog.some((entry) => entry.type === 'release'));
  assert(catalog.some((entry) => entry.type === 'snapshot'));
  assert(catalog.some((entry) => entry.type === 'old_alpha'));
  await shot('01-versions');
  const control = page.locator('.vanilla-install-controls');
  const before = await control.boundingBox();
  assert(before.height < 230, 'Install controls use too much space');
  await page.locator('.library-content').evaluate((element) => {
    element.scrollTop = 700;
  });
  await page.waitForFunction(
    () => document.querySelector('.library-content').scrollTop > 600,
  );
  const after = await control.boundingBox();
  const scrollbox = await page.locator('.library-content').boundingBox();
  assert(
    after.y >= scrollbox.y - 1 && after.y <= scrollbox.y + 3,
    'Install controls did not remain pinned',
  );
  assert(
    after.y + after.height < (await page.evaluate(() => innerHeight)) - 150,
  );
  measurements.sticky = { before, after, scrollbox };
  await shot('02-versions-scrolled');
  console.log(
    'PASS: official release/snapshot/old catalogs, compact controls and real desktop sticky scrolling',
  );

  await page
    .locator('.context-category-list')
    .getByRole('button', { name: '模组', exact: true })
    .click();
  await page.locator('.resource-hit').first().waitFor({ timeout: 60000 });
  const metrics = await page.locator('.resource-hit').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { y: box.y, bottom: box.bottom, height: box.height };
    }),
  );
  const viewport = await page.evaluate(() => innerHeight);
  measurements.resources = metrics;
  const visible = metrics.filter(
    (box) => box.y >= 0 && box.bottom < viewport - 32,
  ).length;
  assert(visible >= 4, `Only ${visible} complete resource rows fit`);
  assert(metrics[0].height < 110, 'Resource rows are still too large');
  const metadata = await page
    .locator('.resource-hit-metadata')
    .first()
    .innerText();
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('.resource-hit img')]
          .slice(0, 4)
          .every((img) => img.complete),
      { timeout: 8000 },
    )
    .catch(() => {});
  measurements.images = await page
    .locator('.resource-hit img')
    .evaluateAll((images) =>
      images.map((img) => ({
        url: img.getAttribute('src'),
        loaded: img.naturalWidth > 0,
      })),
    );
  assert(
    metadata.includes('Modrinth') &&
      metadata.includes('MC 1.21.1') &&
      metadata.includes('次下载') &&
      !metadata.includes('未提供'),
  );
  await shot('03-resources');
  const widths = await page
    .locator('.resource-hit-actions button')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().width),
    );
  assert(new Set(widths).size === 1, 'Source buttons have different widths');
  assert(
    (
      await page.locator('.resource-hit-actions button').allTextContents()
    ).every((text) => text.trim() === 'Modrinth'),
  );
  await page.locator('.library-content').evaluate((element) => {
    element.scrollTop = 700;
  });
  const pinned = await page.locator('.resource-search-dock').boundingBox();
  assert(
    Math.abs(pinned.y - scrollbox.y) < 2,
    'Resource search panel did not stay fixed',
  );
  await shot('07-resources-scrolled');
  await page.locator('.library-content').evaluate((element) => {
    element.scrollTop = 0;
  });
  const firstRow = await page.locator('.resource-hit').first().boundingBox();
  await page.mouse.click(
    firstRow.x + firstRow.width * 0.55,
    firstRow.y + firstRow.height - 8,
  );
  await page
    .locator('.resource-version-list button')
    .first()
    .waitFor({ timeout: 60000 });
  const count = await page.locator('.resource-version-list button').count();
  assert(count > 1, 'Expected multiple actual compatible Mod versions');
  assert.equal(
    await page.getByLabel('搜索在线资源', { exact: true }).count(),
    0,
  );
  const groups = await page
    .locator('.resource-game-group-toggle')
    .allTextContents();
  assert(
    groups.length > 1,
    'Expected versions across several Minecraft series',
  );
  measurements.versionGroups = groups;
  const second = page.locator('.resource-version-list button').nth(1);
  const secondName = await second.locator('strong').innerText();
  await second.click();
  assert.equal(await second.getAttribute('aria-pressed'), 'true');
  const selectedName = await page
    .getByLabel('在线资源兼容版本')
    .locator('option:checked')
    .textContent();
  assert(selectedName.includes(secondName));
  await page.locator('.resource-version-catalog').scrollIntoViewIfNeeded();
  await shot('04-resource-versions');
  console.log(
    `PASS: ${visible} complete rows in 1120×720, genuine downloads/update metadata and ${count} selectable Mod versions`,
  );

  await page.getByRole('button', { name: '返回搜索结果', exact: true }).click();
  await page
    .locator('.resource-source-tabs')
    .getByRole('button', { name: 'CurseForge', exact: true })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'CurseForge API Key' })
    .waitFor();
  await shot('08-curseforge-unconfigured');
  console.log(
    'PASS: source buttons are equal, resource search is pinned, icon opens grouped details and missing CurseForge key is explicit',
  );
  await page
    .locator('.context-category-list')
    .getByRole('button', { name: '原版游戏', exact: true })
    .click();
  await page
    .getByRole('button', { name: /^选择最新预览版 / })
    .waitFor({ timeout: 60000 });
  const snapshotName = await page
    .getByRole('button', { name: /^选择最新预览版 / })
    .getAttribute('aria-label');
  await page.getByRole('button', { name: /^选择最新预览版 / }).click();
  await page.getByLabel('真实实例加载器').selectOption('forge');
  await page
    .locator('.loader-version-list > button')
    .first()
    .waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.official-version-catalog').count(), 0);
  assert(
    !snapshotName.includes(
      await page.getByLabel('原版版本', { exact: true }).innerText(),
    ),
    'Unsupported snapshot stayed selected for Forge',
  );
  await page.getByLabel('原版版本', { exact: true }).click();
  await page.getByRole('searchbox', { name: '筛选原版版本' }).fill('1.21.1');
  await page.getByRole('option', { name: '1.21.1', exact: true }).click();
  await page
    .locator('.loader-version-list > button')
    .filter({ hasText: 'Forge 52.1.20' })
    .waitFor({ timeout: 60000 });
  const forgeRows = await page.locator('.loader-version-list > button').count();
  assert(
    forgeRows > 2,
    'Forge catalogue still contains only promotion entries',
  );
  await page
    .locator('.loader-version-list > button')
    .filter({ hasText: 'Forge 52.1.19' })
    .click();
  assert.equal(
    await page.getByLabel('Forge 版本', { exact: true }).inputValue(),
    '52.1.19',
  );
  await shot('10-forge-catalog');
  await page.getByLabel('真实实例加载器').selectOption('fabric');
  const fabricEntry = page.locator('.loader-version-list > button').first();
  const fabricRetry = page.getByRole('button', {
    name: '重新读取 Fabric 版本',
    exact: true,
  });
  await Promise.race([
    fabricEntry.waitFor({ timeout: 90000 }),
    fabricRetry.waitFor({ timeout: 90000 }),
  ]);
  if (await fabricRetry.isVisible()) await fabricRetry.click();
  await fabricEntry.waitFor({ timeout: 90000 });
  assert((await fabricEntry.innerText()).includes('Fabric'));
  assert.equal(await page.locator('.official-version-catalog').count(), 0);
  assert(
    (
      await page.locator('.loader-version-list img').first().getAttribute('src')
    ).includes('fabric-official'),
  );
  const fabricRows = await page
    .locator('.loader-version-list > button')
    .count();
  assert(fabricRows > 1, 'Fabric history is missing from the catalogue');
  await shot('11-fabric-catalog');
  await page.getByLabel('真实实例加载器').selectOption('vanilla');
  await page.locator('.official-version-catalog').waitFor();
  assert.equal(await page.locator('.loader-version-catalog').count(), 0);
  await page.getByLabel('真实实例加载器').selectOption('forge');
  await page
    .locator('.loader-version-list > button')
    .filter({ hasText: 'Forge 52.1.20' })
    .waitFor({ timeout: 60000 });
  await page
    .locator('.loader-version-list > button')
    .filter({ hasText: 'Forge 52.1.20' })
    .click();
  measurements.loaderCatalogs = { forgeRows, fabricRows };
  console.log(
    'PASS: vanilla/Forge/Fabric catalogs switch, unsupported snapshot falls back, official icons render and row body opens details',
  );
  await page.waitForFunction(
    () => !!document.querySelector('[aria-label="Forge 版本"]')?.value,
    undefined,
    { timeout: 60000 },
  );
  const forgeVersion = await page
    .getByLabel('Forge 版本', { exact: true })
    .inputValue();
  await shot('09-forge-download');
  await page
    .getByRole('button', { name: '下载 Forge 安装器', exact: true })
    .click();
  let task;
  for (let i = 0; i < 600; i++) {
    task = (await invoke('native_status')).task;
    if (task.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(task.status, 'succeeded', task.message);
  const filename = 'forge-1.21.1-' + forgeVersion + '-installer.jar';
  const installer = await readFile(
    path.join(data, 'downloads/forge', filename),
  );
  const actual = createHash('sha1').update(installer).digest('hex');
  const checksum = await fetch(
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-' +
      forgeVersion +
      '/' +
      filename +
      '.sha1',
    { redirect: 'error', signal: AbortSignal.timeout(30000) },
  );
  assert(checksum.ok);
  assert.equal(actual, (await checksum.text()).trim());
  assert.equal((await invoke('native_status')).instances.length, 0);
  measurements.forge = {
    game: '1.21.1',
    version: forgeVersion,
    filename,
    bytes: installer.length,
    sha1: actual,
    executed: false,
  };
  console.log(
    'PASS: actual Forge installer downloaded and SHA-1 verified; no Forge instance falsely published',
  );
  await nav('游戏库');
  await page.locator('.library-account').click();
  await page.getByRole('button', { name: '正版登录', exact: true }).click();
  await page
    .getByRole('button', { name: '打开 Microsoft 官方授权页', exact: true })
    .waitFor();
  assert(
    (await page.locator('.account-panel').innerText()).includes(
      '获取有效设备码需先完成',
    ),
  );
  assert.equal(
    await invoke('native_status').then((state) => state.loginPending),
    false,
  );
  await shot('05-account-official-flow');
  await page.keyboard.press('Escape');
  console.log(
    'PASS: official login entry and Client ID prerequisite are explicit; no account authorization attempted',
  );

  await resize(800, 540);
  await nav('下载');
  await page
    .locator('.context-category-list')
    .getByRole('button', { name: '原版游戏', exact: true })
    .click();
  await page.locator('.official-version-list > button').first().waitFor();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await shot('06-small-versions');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        data,
        measurements,
        visibleResourceRows: visible,
        compatibleModVersions: count,
        errors,
        catalogTypes: [...new Set(catalog.map((entry) => entry.type))],
        note: 'Actual debug desktop and official Forge installer download; no installer execution, game launch or account authorization. CurseForge live install blocked by missing API key.',
      },
      null,
      2,
    ),
  );
  console.log(`Results: ${output}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await shot('failure').catch(() => {});
    console.log(
      await page
        .locator('.native-workspace')
        .innerText()
        .catch(() => ''),
    );
  }
  throw error;
} finally {
  await stop();
}
