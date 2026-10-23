import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const profile = process.argv[2] ?? 'debug';
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
const child = spawn(executable, [], {
  cwd: project,
  windowsHide: true,
  env: {
    ...process.env,
    EASYCRAFT_DATA_DIR: path.join(project, '.native/integration'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let failure = '';
child.on('error', (error) => {
  failure = error.message;
});
child.stderr.on('data', (chunk) => {
  failure = (failure + chunk).slice(-64000);
});
let browser;
let originalSettings;
let page;
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${failure}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert(browser, `WebView2 debugging endpoint unavailable: ${failure}`);
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
    .getByRole('button', { name: '下载中心', exact: true })
    .click();
  await page.getByRole('heading', { name: '原版下载与启动' }).waitFor();
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
  await page
    .getByLabel('选择整合包', { exact: true })
    .setInputFiles(path.join(project, '.native/fixtures/preview.mrpack'));
  await page
    .getByRole('heading', { name: '测试包 · MRPACK', exact: true })
    .waitFor();
  await page.getByText('fabric-loader: 0.16.14', { exact: true }).waitFor();
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
    .getByRole('button', { name: '版本', exact: true })
    .click();
  await page.locator('.library-instance').first().click();
  await page.getByRole('tab', { name: '存档与设置', exact: true }).click();
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
    .getByRole('button', { name: '下载中心', exact: true })
    .click();
  await page
    .getByText('当前启动身份：离线 · EC_OfflineTest（以已保存配置为准）', {
      exact: true,
    })
    .waitFor();
  assert(
    await page
      .getByRole('button', { name: '启动游戏', exact: true })
      .first()
      .isEnabled(),
  );
  if (process.argv.includes('--launch-offline')) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '版本', exact: true })
      .click();
    const chosen = process.argv.includes('--fabric')
      ? page
          .locator('.library-instance')
          .filter({ hasText: 'Fabric 0.16.14' })
          .first()
      : page.locator('.library-instance').first();
    await chosen.click();
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
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke('native_status'),
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
          state.task.logs.some((line) => line.includes('本次游戏最大堆内存')),
        );
        if (process.argv.includes('--fabric'))
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
    await page
      .getByRole('button', { name: '结束游戏进程', exact: true })
      .click();
    await page.waitForFunction(
      async () =>
        (await window.__TAURI_INTERNALS__.invoke('native_status')).task
          .status === 'cancelled',
    );
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
      .evaluate(async (settings) => {
        await window.__TAURI_INTERNALS__.invoke('native_cancel');
        for (let attempt = 0; attempt < 50; attempt++) {
          const state =
            await window.__TAURI_INTERNALS__.invoke('native_status');
          if (state.task.status !== 'running') {
            await window.__TAURI_INTERNALS__.invoke('native_settings', {
              settings,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }, originalSettings)
      .catch(() => {});
  }
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
