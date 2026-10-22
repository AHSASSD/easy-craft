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
  let page = context.pages()[0];
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
  assert.deepEqual(errors, []);
  await mkdir(path.join(project, 'output/playwright'), { recursive: true });
  await page.locator('.page-content').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(project, 'output/playwright/native-desktop.png'),
  });
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
    'PASS: real Tauri/WebView2 renders, IPC Java detection and official version list work, unsigned launch is rejected, native close exits.',
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
