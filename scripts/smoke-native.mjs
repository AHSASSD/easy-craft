import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const profile = process.argv[2] ?? 'debug';
await mkdir(path.join(project, 'output/playwright'), { recursive: true });
assert(['debug', 'release'].includes(profile));
const executable = path.join(
  project,
  `src-tauri/target/${profile}/easy-craft.exe`,
);
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let failure = '';
function launchDesktop() {
  failure = '';
  const desktop = spawn(executable, [], {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: path.join(project, '.native/integration'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  desktop.on('error', (error) => {
    failure = error.message;
  });
  desktop.stderr.on('data', (chunk) => {
    failure = (failure + chunk).slice(-64000);
  });
  return desktop;
}
let child = launchDesktop();
async function connectDesktop() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${failure}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`WebView2 debugging endpoint unavailable: ${failure}`);
}
let browser;
let originalSettings;
let originalInstanceLaunch;
let page;
let installedPack;
let launchedGame;
async function selectNativeFile(button, file) {
  assert.equal(
    profile,
    'debug',
    'Native picker automation is limited to this debug build',
  );
  await button.click();
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/select-native-file.ps1'),
    '-AppProcessId',
    String(child.pid),
  ];
  args.push(...(file ? ['-File', file] : ['-Cancel']));
  const helper = spawn('powershell.exe', args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  helper.stdout.on('data', (value) => (output = (output + value).slice(-8000)));
  helper.stderr.on('data', (value) => (output = (output + value).slice(-8000)));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      helper.kill();
      reject(new Error('Native dialog helper timed out'));
    }, 30000);
    helper.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    helper.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(output));
    });
  });
}
try {
  browser = await connectDesktop();
  const context = browser.contexts()[0];
  page = context.pages()[0];
  if (!page) page = await context.waitForEvent('page');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.library-shell').waitFor();
  assert(
    await page.getByRole('button', { name: '最小化', exact: true }).isVisible(),
  );
  assert(await page.getByRole('button', { name: '最大化或还原' }).isVisible());
  const width = await page.evaluate(() => innerWidth);
  await page.getByRole('button', { name: '最大化或还原' }).click();
  await page.waitForFunction((previous) => innerWidth > previous, width);
  await page.getByRole('button', { name: '最大化或还原' }).click();
  await page.waitForFunction((previous) => innerWidth === previous, width);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '启动', exact: true }).click();
  if (process.argv.includes('--background')) {
    const original = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('native_background'),
    );
    try {
      await page.getByRole('button', { name: '个性化', exact: true }).click();
      const input = page.getByLabel('选择背景图片');
      await input.setInputFiles({
        name: 'background.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLl8AAAAASUVORK5CYII=',
          'base64',
        ),
      });
      await page
        .getByText('背景已保存，下次打开仍然生效。', { exact: true })
        .waitFor();
      const saved = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_background'),
      );
      assert.match(saved, /^data:image\/png;base64,/);
      const oldPid = child.pid;
      const exiting = new Promise((resolve) => child.once('exit', resolve));
      await page
        .getByRole('button', { name: '关闭窗口', exact: true })
        .click()
        .catch(() => {});
      await Promise.race([
        exiting,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Background test desktop did not close')),
            5000,
          ),
        ),
      ]);
      await browser.close();
      child = launchDesktop();
      assert.notEqual(child.pid, oldPid);
      browser = await connectDesktop();
      const reopened = browser.contexts()[0];
      page = reopened.pages()[0] ?? (await reopened.waitForEvent('page'));
      page.on('pageerror', (error) => errors.push(error.message));
      await page.locator('.library-shell').waitFor();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '游戏库', exact: true })
        .click();
      await page.waitForFunction(
        (saved) =>
          document
            .querySelector('.library-hero')
            ?.style.backgroundImage.includes(saved),
        saved,
      );
      for (const mime of ['image/jpeg', 'image/webp']) {
        const data = await page.evaluate((mime) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 2;
          return canvas.toDataURL(mime).split(',')[1];
        }, mime);
        await page
          .getByRole('navigation')
          .getByRole('button', { name: '设置', exact: true })
          .click();
        await page.getByRole('button', { name: '个性化', exact: true }).click();
        await page.getByLabel('选择背景图片').setInputFiles({
          name: 'background.' + mime.split('/')[1],
          mimeType: mime,
          buffer: Buffer.from(data, 'base64'),
        });
        await page
          .getByText('背景已保存，下次打开仍然生效。', { exact: true })
          .waitFor();
        assert.match(
          await page.evaluate(() =>
            window.__TAURI_INTERNALS__.invoke('native_background'),
          ),
          /^data:image\/png;base64,/,
        );
      }
      await page
        .getByRole('button', { name: '恢复原创背景', exact: true })
        .click();
      await page
        .getByRole('button', { name: '恢复原创背景', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(
        await page.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke('native_background'),
        ),
        null,
      );
      console.log(
        'PASS: PNG/JPEG/WebP background converted and persisted; a newly started desktop process restores the actual hero background, reset persists.',
      );
    } finally {
      await page.evaluate(
        (bytes) =>
          window.__TAURI_INTERNALS__.invoke('native_background', { bytes }),
        original
          ? Array.from(Buffer.from(original.split(',')[1], 'base64'))
          : [],
      );
    }
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await page.getByRole('button', { name: '启动', exact: true }).click();
  }
  originalSettings = await page.evaluate(async () => {
    const state = await window.__TAURI_INTERNALS__.invoke('native_status');
    await window.__TAURI_INTERNALS__.invoke('native_settings', {
      settings: { ...state.settings, launchMode: 'microsoft' },
    });
    return state.settings;
  });
  const java = page.getByRole('textbox', { name: 'Java 可执行文件' });
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Java 可执行文件"]')
      ?.value.includes('java.exe'),
  );
  assert((await java.inputValue()).includes('java.exe'));
  await page.getByRole('button', { name: '检测 Java', exact: true }).click();
  await page.getByText('Java 21 · 64 位 · 检测成功', { exact: true }).waitFor();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page.getByRole('button', { name: '原版游戏', exact: true }).click();
  await page.getByRole('heading', { name: '原版游戏', exact: true }).waitFor();
  if (!process.argv.includes('--cached')) {
    await page.getByRole('button', { name: '刷新官方版本' }).click();
    await page.getByText('已读取官方正式版本清单。', { exact: true }).waitFor();
    assert((await page.locator('#official-versions option').count()) > 50);
    await page
      .getByRole('combobox', { name: '真实实例加载器' })
      .selectOption('fabric');
    await page.getByRole('button', { name: '刷新 Fabric 版本' }).click();
    await page.getByText('已读取 Fabric 稳定版本。', { exact: true }).waitFor();
    assert((await page.locator('#fabric-versions option').count()) > 0);
    await page
      .getByRole('combobox', { name: '真实实例加载器' })
      .selectOption('vanilla');
  }
  if (process.argv.includes('--resources')) {
    const resourceTarget = await page.evaluate(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke('native_status');
      return {
        root: state.dataRoot,
        id: state.instances.find(
          (i) => i.fabricVersion && i.version === '1.21.1',
        )?.id,
        vanillaId: state.instances.find(
          (i) => !i.fabricVersion && i.version === '1.21.1',
        )?.id,
      };
    });
    async function installCurrentResource(options = {}) {
      const targetId = options.targetId ?? resourceTarget.id;
      assert(targetId, 'A workspace test instance is required');
      await page.getByLabel('资源安装目标实例').selectOption(targetId);
      if (options.worldId)
        await page.getByLabel('数据包目标世界').selectOption(options.worldId);
      await page
        .getByRole('button', { name: '预览安装变更', exact: true })
        .click();
      await page.getByLabel('资源安装变更预览').waitFor({ timeout: 100000 });
      await page.getByLabel('资源安装变更预览').screenshot({
        path: path.join(project, 'output/playwright/resource-install-plan.png'),
      });
      const normalViewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      await page.setViewportSize({ width: 800, height: 540 });
      assert(
        await page
          .getByLabel('资源安装变更预览')
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      );
      assert(
        await page
          .getByLabel('资源安装变更预览')
          .evaluate((element) => getComputedStyle(element).display === 'block'),
      );
      await page
        .getByRole('button', { name: '确认安装资源', exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(
          project,
          'output/playwright/resource-install-minimum.png',
        ),
      });
      await page.setViewportSize(normalViewport);
      const confirmation = page.getByRole('button', {
        name: '确认安装资源',
        exact: true,
      });
      assert(await confirmation.isDisabled());
      await page.getByLabel('确认在线安装前游戏已关闭').check();
      await confirmation.click();
      await page
        .getByText('资源安装任务已开始，请在底部查看真实进度与结果。', {
          exact: true,
        })
        .waitFor();
      let task;
      const deadline = Date.now() + 120000;
      do {
        task = await page.evaluate(
          async () =>
            (await window.__TAURI_INTERNALS__.invoke('native_status')).task,
        );
        if (['succeeded', 'failed', 'cancelled'].includes(task.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      assert.equal(task.status, 'succeeded', task.message);
      const game = path.resolve(
        resourceTarget.root,
        'instances',
        targetId,
        'game',
      );
      assert(
        game.startsWith(
          path.join(project, '.native', 'integration') + path.sep,
        ),
      );
      const base = options.worldId
        ? path.join(game, 'saves', options.worldId)
        : game;
      const catalog = JSON.parse(
        await readFile(path.join(base, '.easycraft-resources.json'), 'utf8'),
      );
      for (const file of catalog.files) {
        assert(
          /^(mods|resourcepacks|shaderpacks|datapacks)\/[^/\\]+$/.test(
            file.path,
          ),
        );
        if (options.worldId) assert(file.path.startsWith('datapacks/'));
        const bytes = await readFile(path.join(base, file.path));
        assert.equal(
          createHash('sha512').update(bytes).digest('hex'),
          file.sha512,
        );
      }
      return catalog;
    }
    await page.getByRole('button', { name: '模组', exact: true }).click();
    await page.getByLabel('搜索在线资源').fill('FerriteCore');
    await page.getByLabel('在线资源游戏版本').fill('1.21.1');
    await page.getByRole('button', { name: '搜索资源', exact: true }).click();
    await page
      .getByRole('button', { name: '查看 FerriteCore', exact: true })
      .waitFor({ timeout: 100000 });
    await page
      .getByRole('button', { name: '查看 FerriteCore', exact: true })
      .click();
    await page.getByLabel('在线资源兼容版本').waitFor({ timeout: 100000 });
    await page.getByLabel('在线资源兼容版本').selectOption('sOzRw3CG');
    await page
      .locator('.resource-detail li')
      .filter({ hasText: 'ferritecore-7.0.3-fabric.jar' })
      .waitFor();
    assert(
      (await page.locator('.resource-hash').first().textContent()).includes(
        'a8a6a34fcda177da2828cedef44e0e538cf78aad',
      ),
    );
    await page.locator('.resource-detail').screenshot({
      path: path.join(project, 'output/playwright/resource-detail.png'),
    });
    if (process.argv.includes('--install-resources')) {
      const catalog = await installCurrentResource();
      assert(
        catalog.files.some(
          (f) => f.project === 'uXXizFIs' && f.version === 'sOzRw3CG',
        ),
      );
      console.log(
        'PASS: actual FerriteCore download, SHA-512 readback, target directory and source record.',
      );
    }
    await page
      .getByRole('button', { name: '返回搜索结果', exact: true })
      .click();
    assert.equal(
      await page.getByLabel('搜索在线资源').inputValue(),
      'FerriteCore',
    );
    console.log(
      'PASS: real Modrinth search/detail/version/file-hash metadata in desktop UI.',
    );
    if (process.argv.includes('--install-resources')) {
      await page.getByRole('button', { name: '资源包', exact: true }).click();
      await page.getByLabel('搜索在线资源').fill('Default Dark Mode');
      await page.getByLabel('在线资源游戏版本').fill('1.21.1');
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
      await page
        .getByRole('button', { name: '查看 Default Dark Mode', exact: true })
        .waitFor({ timeout: 100000 });
      await page
        .getByRole('button', { name: '查看 Default Dark Mode', exact: true })
        .click();
      await page.getByLabel('在线资源兼容版本').waitFor({ timeout: 100000 });
      await page.getByLabel('在线资源兼容版本').selectOption('S7URnfmp');
      const catalog = await installCurrentResource();
      assert(
        catalog.files.some(
          (f) =>
            f.project === '6SLU7tS5' && f.path.startsWith('resourcepacks/'),
        ),
      );
      console.log(
        'PASS: actual resource-pack install commits to resourcepacks and verifies SHA-512; in-game activation is not claimed.',
      );
    }
    if (process.argv.includes('--install-dependencies')) {
      assert(process.argv.includes('--install-resources'));
      await page.getByRole('button', { name: '模组', exact: true }).click();
      await page.getByLabel('搜索在线资源').fill('Mod Menu');
      await page.getByLabel('在线资源游戏版本').fill('1.21.1');
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
      await page
        .getByRole('button', { name: '查看 Mod Menu', exact: true })
        .waitFor({ timeout: 100000 });
      await page
        .getByRole('button', { name: '查看 Mod Menu', exact: true })
        .click();
      await page.getByLabel('在线资源兼容版本').waitFor({ timeout: 100000 });
      await page.getByLabel('在线资源兼容版本').selectOption('6lgOkclV');
      const catalog = await installCurrentResource();
      for (const projectId of ['mOgUt4GM', 'eXts2L7r', 'P7dR8mSH'])
        assert(
          catalog.files.some((f) => f.project === projectId),
          `Missing required source project ${projectId}`,
        );
      console.log(
        'PASS: actual Mod Menu install includes both required projects, verified catalog hashes and JAR metadata checks.',
      );
    }
    if (process.argv.includes('--install-shader')) {
      assert(process.argv.includes('--install-resources'));
      await page.getByRole('button', { name: '光影包', exact: true }).click();
      await page.getByLabel('搜索在线资源').fill('MakeUp');
      await page.getByLabel('在线资源游戏版本').fill('1.21.1');
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
      const result = page.getByRole('button', { name: /查看 MakeUp/ }).first();
      await result.waitFor({ timeout: 100000 });
      await result.click();
      await page.getByLabel('在线资源兼容版本').waitFor({ timeout: 100000 });
      const version = await page.getByLabel('在线资源兼容版本').inputValue();
      const catalog = await installCurrentResource();
      assert(
        catalog.files.some(
          (f) => f.version === version && f.path.startsWith('shaderpacks/'),
        ),
      );
      console.log(
        'PASS: actual shader ZIP installed to shaderpacks with SHA-512 verification; renderer installation/activation is not claimed.',
      );
    }
    if (process.argv.includes('--install-datapack')) {
      assert(resourceTarget.vanillaId);
      const game = path.resolve(
        resourceTarget.root,
        'instances',
        resourceTarget.vanillaId,
        'game',
      );
      assert(
        game.startsWith(
          path.join(project, '.native', 'integration') + path.sep,
        ),
      );
      const worldName = `EC_DP_${randomUUID()}`;
      const otherWorld = `EC_DP_OTHER_${randomUUID()}`;
      for (const name of [worldName, otherWorld]) {
        await mkdir(path.join(game, 'saves', name), { recursive: true });
        await copyFile(
          path.join(project, '.native/fixtures/world/level.dat'),
          path.join(game, 'saves', name, 'level.dat'),
        );
      }
      const before = await readFile(
        path.join(game, 'saves', worldName, 'level.dat'),
      );
      const otherBefore = await readFile(
        path.join(game, 'saves', otherWorld, 'level.dat'),
      );
      const globalCatalog = await readFile(
        path.join(game, '.easycraft-resources.json'),
      ).catch(() => null);
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '游戏库', exact: true })
        .click();
      await page
        .locator('.library-instance')
        .filter({ hasText: '原版集成验证' })
        .first()
        .click();
      await page.getByRole('tab', { name: '存档', exact: true }).click();
      await page.getByLabel('选择存档').selectOption(worldName);
      await page
        .getByText('此世界还没有本地数据包。', { exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: '获取世界数据包', exact: true })
        .click();
      await page.getByLabel('搜索在线资源').fill('Veinminer');
      await page.getByLabel('在线资源游戏版本').fill('1.21.1');
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
      const result = page
        .getByRole('button', { name: /^查看 Veinminer$/i })
        .first();
      await result.waitFor({ timeout: 100000 });
      await result.click();
      await page.getByLabel('在线资源兼容版本').waitFor({ timeout: 100000 });
      await page.getByLabel('在线资源兼容版本').selectOption('8cEJouzY');
      assert.equal(
        await page.getByLabel('资源安装目标实例').inputValue(),
        resourceTarget.vanillaId,
      );
      assert.equal(
        await page.getByLabel('数据包目标世界').inputValue(),
        worldName,
      );
      const catalog = await installCurrentResource({
        targetId: resourceTarget.vanillaId,
        worldId: worldName,
      });
      assert(
        catalog.files.some(
          (f) =>
            f.project === 'OhduvhIc' &&
            f.version === '8cEJouzY' &&
            f.path === 'datapacks/Veinminer-1.2.4.zip',
        ),
      );
      assert.deepEqual(
        await readFile(path.join(game, 'saves', worldName, 'level.dat')),
        before,
      );
      assert.deepEqual(
        await readFile(path.join(game, 'saves', otherWorld, 'level.dat')),
        otherBefore,
      );
      assert.deepEqual(
        await readFile(path.join(game, '.easycraft-resources.json')).catch(
          () => null,
        ),
        globalCatalog,
      );
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '游戏库', exact: true })
        .click();
      await page.getByRole('tab', { name: '存档', exact: true }).click();
      await page.getByLabel('选择存档').selectOption(worldName);
      await page
        .locator('.world-datapack-files')
        .getByText('Veinminer-1.2.4.zip', { exact: false })
        .waitFor();
      await page.getByLabel('选择存档').selectOption(otherWorld);
      await page
        .getByText('此世界还没有本地数据包。', { exact: true })
        .waitFor();
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '下载', exact: true })
        .click();
      console.log(
        'PASS: actual datapack installed only into the selected vanilla world; SHA-512, untouched level.dat, other-world isolation, remembered navigation and local listing verified. Activation/gameplay is not claimed.',
      );
    }
  }
  await page.getByRole('button', { name: '整合包', exact: true }).click();
  if (
    process.argv.includes('--install-pack') ||
    process.argv.includes('--public-pack') ||
    process.argv.includes('--online-pack')
  ) {
    const before = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('native_status'),
    );
    if (process.argv.includes('--online-pack')) {
      await page.getByLabel('搜索在线资源').fill('Adrenaline');
      await page.getByLabel('在线资源游戏版本').fill('1.21.1');
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
      await page
        .getByRole('button', { name: '查看 Adrenaline', exact: true })
        .click();
      await page.getByLabel('在线资源兼容版本').selectOption('5SA4P3Eo');
      await page
        .getByRole('button', { name: '下载此版本并检查整合包', exact: true })
        .click();
    } else
      await page
        .getByLabel('选择整合包', { exact: true })
        .setInputFiles(
          path.join(
            project,
            process.argv.includes('--public-pack')
              ? '.native/fixtures/adrenaline-1.21.1.mrpack'
              : '.native/fixtures/installable.mrpack',
          ),
        );
    const preview = page.getByLabel('整合包安装变更预览');
    await preview.waitFor({ timeout: 120000 });
    if (process.argv.includes('--online-pack')) {
      const checked = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      assert.deepEqual(checked.instances, before.instances);
      assert.equal(checked.task.phase, 'pack-checked');
      assert.equal(checked.task.status, 'succeeded');
      assert.match(checked.task.message, /尚未安装/);
    }
    const name = `EC MRPACK ${randomUUID().slice(0, 8)}`;
    await page.getByLabel('整合包新实例名称').fill(name);
    await preview.screenshot({
      path: path.join(project, 'output/playwright/modpack-plan.png'),
    });
    await page
      .getByRole('button', { name: '确认变更并安装整合包', exact: true })
      .click();
    await page
      .getByText('整合包安装任务已开始，请查看底部任务状态。', { exact: true })
      .waitFor();
    let result;
    for (let attempt = 0; attempt < 180; attempt++) {
      result = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      assert(
        !['failed', 'cancelled'].includes(result.task.status),
        `${result.task.message}\n${result.task.logs.join('\n')}`,
      );
      installedPack = result.instances.find(
        (instance) => instance.name === name,
      );
      if (installedPack && result.task.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(
      installedPack && result.task.status === 'succeeded',
      'MRPACK task did not complete',
    );
    assert.equal(result.instances.length, before.instances.length + 1);
    assert.deepEqual(
      result.instances.filter((instance) => instance.id !== installedPack.id),
      before.instances,
    );
    const game = path.join(
      result.dataRoot,
      'instances',
      installedPack.id,
      'game',
    );
    if (
      !process.argv.includes('--public-pack') &&
      !process.argv.includes('--online-pack')
    ) {
      assert.equal(
        await readFile(path.join(game, 'config/example.json'), 'utf8'),
        'client',
      );
      assert.equal(
        await readFile(path.join(game, 'options.txt'), 'utf8'),
        'soundCategory_master:0.5\n',
      );
    } else {
      assert.equal(installedPack.fabricVersion, '0.19.5');
      assert.equal(installedPack.version, '1.21.1');
    }
    const origin = JSON.parse(
      await readFile(path.join(game, '.easycraft-pack.json'), 'utf8'),
    );
    if (process.argv.includes('--online-pack')) {
      assert.equal(origin.origin.project, 'BYN9yKrV');
      assert.equal(origin.origin.version, '5SA4P3Eo');
      assert.match(origin.origin.filename, /\.mrpack$/);
      assert.equal(
        origin.archiveSha512,
        '4f91d6537e6341beccf03d39e9127584faa99ef702f93ee71fa3d5e9c0f3a6fd4429303e46943e84ee719d9b8785716a82a455cb4feb6d3a2209e7614ac33ba7',
      );
    }
    for (const file of origin.files)
      assert.equal(
        createHash('sha512')
          .update(await readFile(path.join(game, file.path)))
          .digest('hex'),
        file.sha512,
      );
    assert(
      !before.instances.some((instance) => instance.id === installedPack.id),
    );
    console.log(
      'PASS: MRPACK created a new real instance, applied overrides, verified every stored file hash and preserved the prior instance catalog.',
    );
  }
  if (process.argv.includes('--native-picker')) {
    const picker = page.getByRole('button', { name: /从电脑选择 ZIP/ });
    await selectNativeFile(picker);
    await picker.waitFor({ state: 'visible' });
    await selectNativeFile(
      picker,
      path.join(project, '.native/fixtures/local-large-resource.zip'),
    );
    await page
      .getByRole('heading', { name: '未命名 ZIP · ZIP', exact: true })
      .waitFor();
    assert(
      (await page.getByText(/展开大小/).textContent()).includes('17.0 MB'),
    );
  }
  await page
    .getByLabel('选择整合包', { exact: true })
    .setInputFiles(path.join(project, '.native/fixtures/preview.mrpack'));
  await page
    .getByRole('heading', { name: '测试包 · MRPACK', exact: true })
    .waitFor();
  await page.getByText('fabric-loader: 0.16.14', { exact: true }).waitFor();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  assert(
    await page
      .getByRole('button', { name: '启动游戏', exact: true })
      .first()
      .isDisabled(),
  );
  const denial = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('native_launch', {
        id: 'invalid-instance',
      });
      return 'unexpected success';
    } catch (error) {
      return String(error);
    }
  });
  assert(
    denial.includes('登录'),
    'Host must reject an unsigned launch even if UI guard is bypassed',
  );
  await page.getByRole('button', { name: '管理游戏账户', exact: true }).click();
  await page.getByRole('button', { name: '离线登录', exact: true }).click();
  await page
    .getByRole('textbox', { name: '离线用户名', exact: true })
    .fill('EC_OfflineTest');
  await mkdir(path.join(project, 'output/playwright'), { recursive: true });
  await page.getByRole('dialog', { name: '账户' }).screenshot({
    path: path.join(project, 'output/playwright/account-panel.png'),
  });
  await page.getByRole('button', { name: '使用离线账户', exact: true }).click();
  await page.getByRole('dialog', { name: '账户' }).waitFor({ state: 'hidden' });
  assert(
    (
      await page.getByRole('button', { name: '管理游戏账户' }).textContent()
    ).includes('EC_OfflineTest'),
  );
  await page.getByRole('button', { name: '管理游戏账户', exact: true }).click();
  const skin = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c89168';
    ctx.fillRect(8, 8, 8, 8);
    ctx.fillStyle = '#553b29';
    ctx.fillRect(8, 8, 8, 2);
    ctx.fillRect(10, 14, 4, 1);
    ctx.fillStyle = '#416682';
    ctx.fillRect(10, 12, 1, 1);
    ctx.fillRect(13, 12, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('选择皮肤头像').setInputFiles({
    name: 'skin.png',
    mimeType: 'image/png',
    buffer: Buffer.from(skin, 'base64'),
  });
  await page.getByRole('img', { name: '玩家皮肤头像', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  const testState = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('native_status'),
  );
  const fabricInstance = testState.instances.find(
    (item) => item.fabricVersion === '0.16.14',
  );
  assert(fabricInstance, 'Installed isolated Fabric fixture is required');
  await page.evaluate(async (id) => {
    const rows = await window.__TAURI_INTERNALS__.invoke('native_content', {
      id,
      kind: 'mods',
    });
    for (const item of rows)
      if (
        /^ec-ui-[0-9a-f-]+\.jar$/.test(item.file) &&
        item.enabled &&
        item.editable
      )
        await window.__TAURI_INTERNALS__.invoke('native_content_toggle', {
          id,
          file: item.file,
          revision: item.revision,
          enabled: false,
        });
  }, fabricInstance.id);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await page
    .locator('.library-instance')
    .filter({ hasText: 'Fabric 0.16.14' })
    .first()
    .click();
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  await page.getByLabel('确认内容修改前游戏已关闭').check();
  const localModName = `ec-ui-${randomUUID()}.jar`;
  const localModBytes = await readFile(
    path.join(project, '.native/fixtures/local-test.jar'),
  );
  await page.getByLabel('导入本地模组').setInputFiles({
    name: localModName,
    mimeType: 'application/java-archive',
    buffer: localModBytes,
  });
  const modRow = page
    .locator('.content-file-row')
    .filter({ hasText: localModName });
  await modRow.getByRole('checkbox').click();
  await page.waitForFunction(
    async ({ id, file }) =>
      (
        await window.__TAURI_INTERNALS__.invoke('native_content', {
          id,
          kind: 'mods',
        })
      ).some((item) => item.file === file && !item.enabled),
    { id: fabricInstance.id, file: localModName + '.disabled' },
  );
  const fabricGameDir = path.join(
    testState.dataRoot,
    'instances',
    fabricInstance.id,
    'game',
  );
  assert(
    path
      .resolve(fabricGameDir)
      .startsWith(path.join(project, '.native', 'integration') + path.sep),
  );
  assert.deepEqual(
    await readFile(
      path.join(fabricGameDir, 'mods', localModName + '.disabled'),
    ),
    localModBytes,
  );
  await page.getByRole('tab', { name: '资源与光影', exact: true }).click();
  await page
    .locator('.content-subtabs')
    .getByRole('button', { name: '资源包', exact: true })
    .click();
  const localResourceName = `ec-resource-${randomUUID()}.zip`;
  await page.getByLabel('确认内容修改前游戏已关闭').check();
  await page.getByLabel('导入本地资源包').setInputFiles({
    name: localResourceName,
    mimeType: 'application/zip',
    buffer: await readFile(
      path.join(project, '.native/fixtures/local-resource.zip'),
    ),
  });
  await page
    .locator('.content-file-row')
    .filter({ hasText: localResourceName })
    .waitFor();
  if (process.argv.includes('--native-picker')) {
    const fixture = path.join(
      project,
      `.native/fixtures/large-${randomUUID()}.zip`,
    );
    await copyFile(
      path.join(project, '.native/fixtures/local-large-resource.zip'),
      fixture,
    );
    try {
      const picker = page.getByRole('button', { name: /选择本地资源包（最大/ });
      await selectNativeFile(picker);
      await page.waitForFunction(
        () => !document.querySelector('.content-manager button')?.disabled,
      );
      assert.equal(await page.getByRole('status').count(), 0);
      await selectNativeFile(picker, fixture);
      await page
        .locator('.content-file-row')
        .filter({ hasText: path.basename(fixture) })
        .waitFor();
      const installed = path.join(
        fabricGameDir,
        'resourcepacks',
        path.basename(fixture),
      );
      const sourceBytes = await readFile(fixture);
      assert.deepEqual(await readFile(installed), sourceBytes);
      await selectNativeFile(picker, fixture);
      await page
        .getByRole('alert')
        .filter({ hasText: /目标已存在/ })
        .waitFor();
      assert.deepEqual(await readFile(installed), sourceBytes);
      console.log(
        'PASS: real Windows file picker cancellation, 17 MiB archive preview/import, exact bytes and duplicate protection. No pack activation claimed.',
      );
    } finally {
      await rm(fixture);
    }
  }
  await page
    .locator('.content-subtabs')
    .getByRole('button', { name: '光影包', exact: true })
    .click();
  const localShaderName = `ec-shader-${randomUUID()}.zip`;
  await page.getByLabel('确认内容修改前游戏已关闭').check();
  await page.getByLabel('导入本地光影包').setInputFiles({
    name: localShaderName,
    mimeType: 'application/zip',
    buffer: await readFile(
      path.join(project, '.native/fixtures/local-shader.zip'),
    ),
  });
  await page
    .locator('.content-file-row')
    .filter({ hasText: localShaderName })
    .waitFor();
  await page.getByLabel('搜索本地光影包').fill(localShaderName);
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  await page.getByLabel('搜索本地模组').fill(localModName);
  await page.getByRole('tab', { name: '资源与光影', exact: true }).click();
  assert.equal(
    await page.getByLabel('搜索本地光影包').inputValue(),
    localShaderName,
  );
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  assert.equal(
    await page.getByLabel('搜索本地模组').inputValue(),
    localModName,
  );
  await page.getByLabel('搜索本地模组').fill('');
  await page.getByRole('tab', { name: '资源与光影', exact: true }).click();
  await page.getByLabel('搜索本地光影包').fill('');
  const screenshotName = `ec-ui-${randomUUID()}.png`;
  await mkdir(path.join(fabricGameDir, 'screenshots'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(fabricGameDir, 'screenshots', screenshotName),
    Buffer.from(skin, 'base64'),
  );
  await page.getByRole('tab', { name: '截图', exact: true }).click();
  const thumbnail = page.getByRole('img', {
    name: `${screenshotName} 缩略图`,
    exact: true,
  });
  await page
    .locator('.content-file-row')
    .filter({ hasText: screenshotName })
    .scrollIntoViewIfNeeded();
  await thumbnail.waitFor();
  assert(
    await thumbnail.evaluate(
      (image) =>
        image.complete && image.naturalWidth > 0 && image.naturalWidth <= 240,
    ),
  );
  await page
    .locator('.content-file-row')
    .filter({ hasText: screenshotName })
    .getByRole('button', { name: '查看截图', exact: true })
    .click();
  await page.getByRole('img', { name: screenshotName, exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('tab', { name: '实例详情', exact: true }).click();
  await page
    .locator('.library-instance')
    .filter({ hasText: 'Fabric 0.16.14' })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menu', { name: '实例操作', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByLabel('真实实例名称').fill('EC 重命名验收');
  await page.getByRole('button', { name: '保存实例名称', exact: true }).click();
  await page
    .getByRole('heading', { name: 'EC 重命名验收', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '重命名实例', exact: true }).click();
  await page.getByLabel('真实实例名称').fill(fabricInstance.name);
  await page.getByRole('button', { name: '保存实例名称', exact: true }).click();
  await page
    .getByRole('heading', { name: fabricInstance.name, exact: true })
    .waitFor();
  console.log(
    'PASS: native local mod import/disable, resources/shaders, screenshot preview and persisted instance rename.',
  );
  const instanceId = testState.instances[0].id;
  const worldId = `EasyCraft_UI_${randomUUID()}`;
  const gameDir = path.join(
    testState.dataRoot,
    'instances',
    instanceId,
    'game',
  );
  assert(
    path
      .resolve(gameDir)
      .startsWith(path.join(project, '.native', 'integration') + path.sep),
  );
  const worldDir = path.join(gameDir, 'saves', worldId);
  await mkdir(worldDir, { recursive: true });
  await copyFile(
    path.join(project, '.native/fixtures/world/level.dat'),
    path.join(worldDir, 'level.dat'),
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await page.locator('.library-instance').first().click();
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.getByLabel('选择存档', { exact: true }).selectOption(worldId);
  await page.getByLabel('世界难度', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('世界时间', { exact: true }).inputValue(),
    '9007199254740993',
  );
  assert(
    await page
      .getByRole('button', { name: '保存世界设置', exact: true })
      .isDisabled(),
  );
  await page.getByLabel('确认游戏已关闭').check();
  await page.getByLabel('世界难度', { exact: true }).selectOption('3');
  await page.getByLabel('死亡不掉落', { exact: true }).check();
  await page.getByLabel('世界时间', { exact: true }).fill('13000');
  await page.getByLabel('世界天气', { exact: true }).selectOption('rain');
  await page
    .getByRole('button', { name: '保存世界设置与规则', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: '原文件已备份' }).waitFor();
  const savedWorld = await page.evaluate(
    ({ id, worldId }) =>
      window.__TAURI_INTERNALS__.invoke('native_world', { id, worldId }),
    { id: instanceId, worldId },
  );
  assert.equal(savedWorld.difficulty, 3);
  assert.equal(savedWorld.dayTime, '13000');
  assert.equal(savedWorld.weather, 'rain');
  assert.equal(
    savedWorld.gameRules.find((rule) => rule.key === 'keepInventory').value,
    'true',
  );
  const backup = (
    await page
      .getByRole('status')
      .filter({ hasText: '原文件已备份' })
      .innerText()
  ).split('原文件已备份：')[1];
  assert.deepEqual(
    await readFile(backup),
    await readFile(path.join(project, '.native/fixtures/world/level.dat')),
  );
  await page.getByRole('tab', { name: '实例设置', exact: true }).click();
  await page.getByLabel('确认游戏已关闭').check();
  await page.getByLabel('渲染距离', { exact: true }).fill('10');
  await page.getByRole('button', { name: '保存音画设置', exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.__TAURI_INTERNALS__.invoke('native_options', { id }))
        .renderDistance === 10,
    instanceId,
  );
  await page.screenshot({
    path: path.join(project, 'output/playwright/world-settings.png'),
  });
  console.log(
    'PASS: native skin avatar, world rules/difficulty/time/weather, exact backup and options round trip.',
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '启动', exact: true }).click();
  await page.getByRole('meter', { name: '系统已使用内存' }).waitFor();
  await page
    .getByRole('combobox', { name: '内存分配方式' })
    .selectOption('manual');
  await page
    .getByRole('spinbutton', { name: '最大内存', exact: true })
    .fill('3072');
  await page.getByRole('checkbox', { name: '启动前内存整理' }).check();
  await page.getByRole('button', { name: '保存内存设置' }).click();
  await page
    .getByText('内存设置已保存，下次启动生效。', { exact: true })
    .waitFor();
  const memorySettings = await page.evaluate(
    async () =>
      (await window.__TAURI_INTERNALS__.invoke('native_status')).settings,
  );
  assert.equal(memorySettings.memoryMb, 3072);
  assert.equal(memorySettings.memoryMode, 'manual');
  assert.equal(memorySettings.optimizeMemory, true);
  await page.getByRole('button', { name: '仅整理启动器', exact: true }).click();
  await page
    .getByText('已请求 Windows 整理启动器工作集，当前可用内存已刷新。', {
      exact: true,
    })
    .waitFor();
  await page
    .getByRole('combobox', { name: '内存分配方式' })
    .selectOption('auto');
  await page.getByRole('checkbox', { name: '启动前内存整理' }).uncheck();
  await page.getByRole('button', { name: '保存内存设置' }).click();
  await page
    .getByText('内存设置已保存，下次启动生效。', { exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(project, 'output/playwright/memory-panel.png'),
  });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  assert(
    await page
      .getByRole('button', { name: '启动游戏', exact: true })
      .first()
      .isEnabled(),
  );
  if (process.argv.includes('--launch-offline')) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '游戏库', exact: true })
      .click();
    const chosen = installedPack
      ? page
          .locator('.library-instance')
          .filter({ hasText: installedPack.name })
          .first()
      : process.argv.includes('--fabric')
        ? page
            .locator('.library-instance')
            .filter({ hasText: 'Fabric 0.16.14' })
            .first()
        : page.locator('.library-instance').first();
    await chosen.click();
    if (process.argv.includes('--instance-settings')) {
      const id = (
        installedPack ??
        (process.argv.includes('--fabric')
          ? fabricInstance
          : testState.instances[0])
      ).id;
      const before = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      originalInstanceLaunch = {
        id,
        launch: before.instances.find((item) => item.id === id).launch ?? {},
      };
      await page.getByRole('tab', { name: '实例设置', exact: true }).click();
      await page.getByLabel('继承全局 Java').uncheck();
      await page.getByLabel('Java 可执行文件').fill(before.settings.javaPath);
      await page
        .getByRole('button', { name: '保存 Java 设置', exact: true })
        .click();
      await page
        .getByText('Java 设置已保存，下次启动生效。', { exact: true })
        .waitFor();
      await page.getByLabel('继承全局内存').uncheck();
      await page.getByLabel('内存分配方式').selectOption('manual');
      await page.getByLabel('最大内存', { exact: true }).fill('1536');
      await page.getByLabel('启动前内存整理').uncheck();
      await page
        .getByRole('button', { name: '保存内存设置', exact: true })
        .click();
      await page
        .getByText('内存设置已保存，下次启动生效。', { exact: true })
        .waitFor();
      const saved = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      assert.deepEqual(saved.settings, before.settings);
      assert.deepEqual(
        saved.instances.filter((item) => item.id !== id),
        before.instances.filter((item) => item.id !== id),
      );
      assert.deepEqual(saved.instances.find((item) => item.id === id).launch, {
        javaPath: before.settings.javaPath,
        memory: { memoryMode: 'manual', memoryMb: 1536, optimizeMemory: false },
      });
      await page.reload();
      await page.getByLabel('继承全局 Java').waitFor();
      assert.equal(await page.getByLabel('继承全局 Java').isChecked(), false);
      assert.equal(
        await page.getByLabel('最大内存', { exact: true }).inputValue(),
        '1536',
      );
      await page.evaluate(async () => {
        const state = await window.__TAURI_INTERNALS__.invoke('native_status');
        await window.__TAURI_INTERNALS__.invoke('native_settings', {
          settings: {
            ...state.settings,
            javaPath: '',
            memoryMode: 'manual',
            memoryMb: 4096,
            optimizeMemory: false,
          },
        });
      });
    }
    await page.getByRole('tab', { name: '实例详情', exact: true }).click();
    await page.locator('.page-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(project, 'output/playwright/library-native.png'),
    });
    const launchButton = page.getByRole('button', {
      name: '启动游戏',
      exact: true,
    });
    await launchButton.click();
    let rendered = false;
    let sawMemoryAllocation = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      if (state.task.pid && installedPack)
        launchedGame = {
          pid: state.task.pid,
          directory: path.join(
            state.dataRoot,
            'instances',
            installedPack.id,
            'game',
          ),
        };
      sawMemoryAllocation ||= state.task.logs.some((line) =>
        line.includes('本次游戏最大堆内存'),
      );
      assert.notEqual(
        state.task.status,
        'failed',
        `${state.task.message}\n${state.task.logs.join('\n')}`,
      );
      if (
        state.task.pid &&
        state.task.logs.some((line) => line.includes('OpenAL initialized'))
      ) {
        assert(
          sawMemoryAllocation,
          'The launch must report its actual heap allocation before startup',
        );
        if (process.argv.includes('--instance-settings')) {
          const info = await new Promise((resolve, reject) =>
            execFile(
              'powershell.exe',
              [
                '-NoProfile',
                '-Command',
                `$game = Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.task.pid}'; [pscustomobject]@{ Path = $game.ExecutablePath; Args = $game.CommandLine } | ConvertTo-Json -Compress`,
              ],
              { windowsHide: true },
              (error, stdout) =>
                error ? reject(error) : resolve(JSON.parse(stdout)),
            ),
          );
          const target = state.instances.find(
            (item) => item.id === originalInstanceLaunch.id,
          );
          assert.equal(
            path.normalize(info.Path).toLowerCase(),
            path.normalize(target.launch.javaPath).toLowerCase(),
          );
          assert.match(info.Args, /(?:^|\s)-Xmx1536M(?:\s|$)/);
          assert.equal(state.settings.javaPath, '');
          assert.equal(state.settings.memoryMb, 4096);
          const refused = await page.evaluate(
            async ({ id, expected }) => {
              try {
                await window.__TAURI_INTERNALS__.invoke(
                  'native_instance_launch_settings',
                  { id, expected, launch: {} },
                );
                return '';
              } catch (error) {
                return String(error);
              }
            },
            { id: target.id, expected: target.launch },
          );
          assert.match(refused, /请先结束/);
          console.log(
            'PASS: actual game uses the instance Java and -Xmx1536M despite empty global Java and 4096 MB global memory; running edits are refused.',
          );
        }
        const launchLog = installedPack
          ? await readFile(
              path.join(
                state.dataRoot,
                'instances',
                installedPack.id,
                'game/logs/latest.log',
              ),
              'utf8',
            )
          : state.task.logs.join('\n');
        if (installedPack?.fabricVersion)
          assert(
            launchLog.includes(
              `with Fabric Loader ${installedPack.fabricVersion}`,
            ),
          );
        if (
          process.argv.includes('--public-pack') ||
          process.argv.includes('--online-pack')
        )
          assert(
            launchLog.includes('ferritecore'),
            'Published pack mods must appear in the actual game log',
          );
        if (process.argv.includes('--fabric') && !installedPack)
          assert(
            state.task.logs.some((line) =>
              line.includes('with Fabric Loader 0.16.14'),
            ),
          );
        rendered = true;
        const lockedEdit = await page.evaluate(
          async ({ id, worldId, settings }) => {
            try {
              await window.__TAURI_INTERNALS__.invoke('native_world_save', {
                id,
                worldId,
                settings,
              });
              return '';
            } catch (error) {
              return String(error);
            }
          },
          { id: instanceId, worldId, settings: savedWorld },
        );
        assert(
          lockedEdit.includes('请先结束'),
          'Native guard must reject world writes while the game runs',
        );
        console.log(
          `PASS: actual offline Minecraft process ${state.task.pid} initialized audio; no Microsoft account or Client ID used.`,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(
      rendered,
      'Actual game did not reach engine initialization within 120 seconds',
    );
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await page.getByRole('dialog', { name: '游戏仍在运行' }).waitFor();
    await page.getByRole('button', { name: '取消关闭', exact: true }).click();
    const stillRunning = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('native_status'),
    );
    assert(stillRunning.task.pid, 'Cancelling close must keep the game alive');
    await page.getByRole('button', { name: '查看任务', exact: true }).click();
    await page
      .getByRole('button', { name: '结束游戏进程', exact: true })
      .click();
    let stopped;
    for (let attempt = 0; attempt < 300; attempt++) {
      stopped = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      if (stopped.task.status === 'cancelled' && stopped.task.pid === null)
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(
      stopped.task.status === 'cancelled' && stopped.task.pid === null,
      `Game stop did not finish: ${stopped.task.message}`,
    );
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    if (originalInstanceLaunch) {
      await page.getByRole('tab', { name: '实例设置', exact: true }).click();
      await page.getByLabel('继承全局 Java').check();
      await page
        .getByRole('button', { name: '保存 Java 设置', exact: true })
        .click();
      await page
        .getByText('Java 设置已保存，下次启动生效。', { exact: true })
        .waitFor();
      await page.getByLabel('继承全局内存').check();
      await page
        .getByRole('button', { name: '保存内存设置', exact: true })
        .click();
      await page
        .getByText('内存设置已保存，下次启动生效。', { exact: true })
        .waitFor();
      const cleared = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
      );
      assert.equal(
        cleared.instances.find((item) => item.id === originalInstanceLaunch.id)
          .launch,
        undefined,
      );
      await page.evaluate(
        ({ id, launch }) =>
          window.__TAURI_INTERNALS__.invoke('native_instance_launch_settings', {
            id,
            expected: {},
            launch,
          }),
        originalInstanceLaunch,
      );
      originalInstanceLaunch = undefined;
      console.log(
        'PASS: restoring inheritance removes both overrides; the test instance configuration is restored.',
      );
    }
  }
  assert.deepEqual(errors, []);
  await mkdir(path.join(project, 'output/playwright'), { recursive: true });
  await page.locator('.page-content').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(project, 'output/playwright/native-desktop.png'),
  });
  await page.evaluate(
    (settings) =>
      window.__TAURI_INTERNALS__.invoke('native_settings', { settings }),
    originalSettings,
  );
  originalSettings = undefined;
  const closing = new Promise((resolve) => child.once('exit', resolve));
  await page
    .getByRole('button', { name: '关闭窗口', exact: true })
    .click()
    .catch(() => {});
  await Promise.race([
    closing,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Native close did not exit')), 5000),
    ),
  ]);
  console.log(
    `PASS: real Tauri/WebView2, Java, ${process.argv.includes('--cached') ? 'cached resources' : 'official version queries'}, Microsoft login guard, offline configuration and native close.`,
  );
} catch (error) {
  if (page) {
    console.error(
      await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => 'world panel unavailable'),
    );
    await page
      .screenshot({
        path: path.join(project, 'output/playwright/native-failure.png'),
      })
      .catch(() => {});
  }
  throw error;
} finally {
  if (originalSettings && page) {
    await page
      .evaluate(
        async ({ settings, instanceLaunch }) => {
          await window.__TAURI_INTERNALS__.invoke('native_cancel');
          for (let attempt = 0; attempt < 50; attempt++) {
            const state =
              await window.__TAURI_INTERNALS__.invoke('native_status');
            if (state.task.status !== 'running') {
              if (instanceLaunch) {
                const current = state.instances.find(
                  (item) => item.id === instanceLaunch.id,
                );
                await window.__TAURI_INTERNALS__.invoke(
                  'native_instance_launch_settings',
                  {
                    id: current.id,
                    expected: current.launch ?? {},
                    launch: instanceLaunch.launch,
                  },
                );
              }
              await window.__TAURI_INTERNALS__.invoke('native_settings', {
                settings,
              });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
        { settings: originalSettings, instanceLaunch: originalInstanceLaunch },
      )
      .catch(() => {});
  }
  try {
    if (launchedGame)
      await new Promise((resolve, reject) => {
        const cleanup = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(project, 'scripts/stop-native-test-processes.ps1'),
            '-GameProcessId',
            String(launchedGame.pid),
            '-GameDirectory',
            launchedGame.directory,
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        cleanup.stdout.on(
          'data',
          (chunk) => (output = (output + chunk).slice(-8000)),
        );
        cleanup.stderr.on(
          'data',
          (chunk) => (output = (output + chunk).slice(-8000)),
        );
        cleanup.once('error', reject);
        cleanup.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(output)),
        );
      });
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
