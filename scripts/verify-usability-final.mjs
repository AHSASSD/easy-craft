// Empty synthetic instance only. No game launch or personal data access.
import assert from 'node:assert/strict';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd(),
  id = randomUUID();
const data = path.join(project, '.native/usability-final', id);
const output = path.join(project, 'output/playwright/usability-final', id);
await mkdir(path.join(data, 'instances', id, 'game'), { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([
    {
      id,
      name: '界面细节验证',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
      ...(process.env.EASYCRAFT_FIRST_USE_CHECK
        ? { launch: { javaPath: 'Z:/missing-easycraft-fixture/java.exe' } }
        : {}),
    },
  ]),
);
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
      ...(process.env.EASYCRAFT_RUNTIME_UI_CHECK
        ? {
            EASYCRAFT_JAVA: path.join(data, 'unconfigured/java.exe'),
            JAVA_HOME: '',
            JDK_HOME: '',
            APPDATA: path.join(data, 'appdata'),
            ProgramFiles: path.join(data, 'program-files'),
          }
        : {}),
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  },
);
let browser;
try {
  for (let attempt = 0; attempt < 60 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  await page.locator('.library-instance').first().waitFor();
  if (process.env.EASYCRAFT_RUNTIME_UI_CHECK) {
    const begin = () =>
      page.evaluate((id) => {
        window.__runtimeResult = null;
        void window.__TAURI_INTERNALS__
          .invoke('native_java_prepare', { id })
          .then(
            (value) => {
              window.__runtimeResult = { value };
            },
            (error) => {
              window.__runtimeResult = { error: String(error) };
            },
          );
      }, id);
    await begin();
    const waitDownload = async () => {
      const until = Date.now() + 60000;
      while (Date.now() < until) {
        const value = await page.evaluate(async () => ({
          task: (await window.__TAURI_INTERNALS__.invoke('native_status')).task,
          result: window.__runtimeResult,
        }));
        if (
          value.task.phase === 'java-download' &&
          value.task.status === 'running'
        )
          return;
        if (value.result) throw new Error(JSON.stringify(value));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Runtime download did not begin');
    };
    await waitDownload();
    await page.getByRole('button', { name: '任务与日志', exact: true }).click();
    await page.getByRole('button', { name: '取消任务', exact: true }).click();
    await page.waitForFunction(() => window.__runtimeResult !== null);
    assert(await page.evaluate(() => !!window.__runtimeResult.error));
    await assert.rejects(
      access(path.join(data, 'runtimes')),
      'cancel must not publish a runtime',
    );
    await page.screenshot({ path: path.join(output, 'java-cancelled.png') });
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await begin();
    await waitDownload();
    await page.getByRole('button', { name: '任务与日志', exact: true }).click();
    await page.getByRole('button', { name: '取消任务', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'java-download.png') });
    await page.waitForFunction(() => window.__runtimeResult !== null, null, {
      timeout: 180000,
    });
    const result = await page.evaluate(() => window.__runtimeResult);
    assert.equal(result.error, undefined);
    assert.equal(result.value.major, 21);
    assert.equal(result.value.is64Bit, true);
    const reused = await page.evaluate(
      (id) => window.__TAURI_INTERNALS__.invoke('native_instance_java', { id }),
      id,
    );
    assert.equal(reused.path, result.value.path);
    await page.getByText('Java 21 已准备好', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(output, 'java-ready.png') });
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    console.log(
      'Runtime UI: cancel preserves staging; retry installs official Java 21; automatic matching reuses it; no game launched.',
    );
  }
  if (process.env.EASYCRAFT_FIRST_USE_CHECK) {
    await page.locator('.library-launch').click();
    await page.getByRole('button', { name: '离线登录', exact: true }).click();
    await page
      .getByRole('textbox', { name: '离线用户名' })
      .fill('FirstUseFixture');
    await page
      .getByRole('button', { name: '使用离线账户', exact: true })
      .click();
    await page.locator('.account-panel').waitFor({ state: 'hidden' });
    await page.locator('.library-launch').click();
    await page.getByText(/Java 检查未通过/).waitFor();
    const task = await page.evaluate(
      async () =>
        (await window.__TAURI_INTERNALS__.invoke('native_status')).task,
    );
    assert.equal(
      task.status,
      'idle',
      'preflight must not launch or create a game task',
    );
    await page.screenshot({ path: path.join(output, 'first-use-java.png') });
    await page
      .getByRole('button', { name: '打开实例设置', exact: true })
      .click();
    assert.equal(
      await page
        .getByRole('tab', { name: '实例设置', exact: true })
        .getAttribute('aria-selected'),
      'true',
    );
    console.log(
      'First use: account entry, offline profile, Java failure and settings navigation passed; no game launched.',
    );
  }
  const nav = (name) =>
    page
      .getByRole('navigation')
      .getByRole('button', { name, exact: true })
      .click();
  const resize = (width, height) =>
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        path.join(project, 'scripts/resize-native-test-window.ps1'),
        '-AppProcessId',
        String(app.pid),
        '-Width',
        String(width),
        '-Height',
        String(height),
      ],
      { windowsHide: true },
    );
  for (const [theme, label] of [
    ['dark', '深板岩夜色'],
    ['light', '草方块亮色'],
  ]) {
    await nav('设置');
    await page.getByRole('button', { name: '个性化', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(label) }).click();
    await nav('游戏库');
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    for (const folder of [
      '游戏文件夹',
      '模组文件夹',
      '存档文件夹',
      '截图文件夹',
      '资源包文件夹',
      '光影包文件夹',
    ])
      assert.equal(
        await page.getByRole('button', { name: folder, exact: true }).count(),
        1,
      );
    const storage = page.locator('.instance-storage-path');
    assert.equal(
      await storage.getAttribute('title'),
      await storage.textContent(),
    );
    await page.getByRole('tab', { name: '实例设置', exact: true }).click();
    for (const [width, height] of [
      [1120, 720],
      [800, 540],
    ]) {
      resize(width, height);
      await page
        .locator('.instance-settings-nav button')
        .filter({ hasText: '运行环境' })
        .click();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      const pathInput = page.getByRole('textbox', { name: 'Java 可执行文件' });
      assert.equal(
        await pathInput.getAttribute('title'),
        (await pathInput.inputValue()) || '尚未指定 Java 路径',
      );
      assert.equal(
        await page.locator('.runtime-settings-card details').count(),
        1,
        'only the existing advanced memory section is collapsed',
      );
      const category = await page
        .locator('.instance-settings-nav')
        .boundingBox();
      const content = await page
        .locator('.instance-settings-content')
        .boundingBox();
      assert(
        content.x >= category.x + category.width - 1,
        'settings sidebar remains unchanged',
      );
      await page.screenshot({
        path: path.join(output, `runtime-${theme}-${width}.png`),
      });
    }
  }
  // A real failed task, using a nonexistent test ID, without network or game writes.
  await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('native_translation_install', {
        id: 'missing-usability-fixture',
      });
    } catch {
      /* expected */
    }
  });
  await page.getByRole('button', { name: '任务与日志', exact: true }).click();
  await page.getByText('下一步：', { exact: false }).waitFor();
  const report = page.getByRole('textbox', { name: '诊断摘要' });
  await report.waitFor();
  assert.match(await report.inputValue(), /实例不存在/);
  await page.getByRole('button', { name: '复制诊断摘要', exact: true }).click();
  await page.getByText(/诊断摘要已复制|无法访问剪贴板/).waitFor();
  await page.screenshot({ path: path.join(output, 'diagnostics.png') });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      { data, output, passed: true, gameLaunched: false },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ output, passed: true }));
} finally {
  await browser?.close();
  app.kill();
}
