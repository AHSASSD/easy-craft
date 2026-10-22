import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
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
  await page.getByRole('heading', { name: '世界很大，轻松出发。' }).waitFor();
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
  await page.getByRole('button', { name: '刷新官方版本' }).click();
  await page.getByText('已读取官方正式版本清单。', { exact: true }).waitFor();
  assert((await page.locator('#official-versions option').count()) > 50);
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
  await page
    .getByRole('combobox', { name: '启动账户模式', exact: true })
    .selectOption('offline');
  await page
    .getByRole('textbox', { name: '离线用户名', exact: true })
    .fill('EC_OfflineTest');
  await page.getByRole('button', { name: '保存原生配置', exact: true }).click();
  await page.getByText('原生配置已保存。', { exact: true }).waitFor();
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
      .getByRole('button', { name: '启动游戏', exact: true })
      .first()
      .click();
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
        rendered = true;
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
    await page
      .getByRole('heading', { name: '原版任务已取消', exact: true })
      .waitFor();
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
    'PASS: real Tauri/WebView2, Java, official versions, Microsoft login guard, offline configuration and native close.',
  );
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
