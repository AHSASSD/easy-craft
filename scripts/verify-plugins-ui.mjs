// Real Tauri/WebView UI, managed package files and Windows Recycle Bin.
// Two empty synthetic instance directories; never opens a player's game/account.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
const project = process.cwd();
const run = randomUUID();
const data = path.join(project, '.native/plugins-ui', run);
const output = path.join(project, 'output/playwright/plugins', run);
await mkdir(output, { recursive: true });
const ids = [randomUUID(), randomUUID()];
for (const id of ids)
  await mkdir(path.join(data, 'instances', id, 'game/mods'), {
    recursive: true,
  });
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify(
    ids.map((id, i) => ({
      id,
      name: `插件测试实例 ${i + 1}`,
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
    })),
  ),
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
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  },
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const command = (args) =>
  new Promise((resolve, reject) =>
    execFile('powershell.exe', args, { windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
let browser;
let page;
const checks = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.library-instance').first().waitFor();
  const resize = async (width, height) =>
    command([
      '-NoProfile',
      '-File',
      'scripts/resize-native-test-window.ps1',
      '-AppProcessId',
      String(app.pid),
      '-Width',
      String(width),
      '-Height',
      String(height),
      '-BuildProfile',
      'debug',
    ]);
  await resize(1120, 720);
  const extensions = () =>
    page
      .getByRole('navigation')
      .getByRole('button', { name: '扩展', exact: true })
      .click();
  await extensions();
  await expect(
    page.getByRole('button', { name: '我的工具', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  const install = async (filename) => {
    await page
      .getByLabel('导入本地插件', { exact: true })
      .setInputFiles(filename);
  };
  const jsonFile = path.join(project, 'docs/plugins/json-tools.ecplugin.json');
  // Exercise the visible import control and the actual WebView file chooser.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '本地导入', exact: true }).click();
  await (await chooser).setFiles(jsonFile);
  await expect(
    page.getByRole('heading', { name: 'JSON 工具', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '格式化', exact: true }),
  ).toBeDisabled();
  await page.getByRole('switch', { name: '启用', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '格式化', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'JSON 输入', exact: true })
    .fill('{"hello":[1,true],"世界":"离线"}');
  await page.getByRole('button', { name: '格式化', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'JSON 结果', exact: true }),
  ).toHaveValue(/\n/);
  checks.push('native-file-chooser', 'real-tool-enabled-running-completed');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: /深板岩夜色/ }).click();
  await extensions();
  await expect(
    page.getByRole('switch', { name: '启用', exact: true }),
  ).toBeEnabled();
  await pause(250);
  await page.screenshot({ path: path.join(output, 'tool-dark-1120.png') });
  const cancelChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '本地导入', exact: true }).click();
  await (await cancelChooser).setFiles([]);
  await expect(
    page.getByRole('heading', { name: 'JSON 工具', exact: true }),
  ).toBeVisible();
  checks.push('cancel-file-selection');
  await page.getByRole('button', { name: '实例扩展', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'JSON 工具', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'JSON 输入', exact: true }),
  ).toHaveValue(/hello/);
  const dropRaw = await readFile(
    path.join(project, 'docs/plugins/instance-check.ecplugin.json'),
    'utf8',
  );
  const transfer = await page.evaluateHandle((raw) => {
    const d = new DataTransfer();
    d.items.add(
      new File([raw], 'instance-check.ecplugin.json', {
        type: 'application/json',
      }),
    );
    return d;
  }, dropRaw);
  await page.dispatchEvent('body', 'drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(
    page.getByRole('heading', { name: '实例模组检查', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '生效实例', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/插件测试实例 1/)
    .check();
  await page.getByRole('button', { name: '应用范围', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('drag-import', 'scoped-activation');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await page
    .locator('.library-instance')
    .filter({ hasText: '插件测试实例 1' })
    .click();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '扩展模组检查', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '扩展模组检查', exact: true }).click();
  await page.getByRole('button', { name: '检查此实例', exact: true }).click();
  await expect(page.getByText(/已检查 0 个归档/)).toBeVisible();
  await page.screenshot({ path: path.join(output, 'instance-check.png') });
  await page.getByRole('tab', { name: '模组诊断', exact: true }).click();
  await page
    .locator('.library-instance')
    .filter({ hasText: '插件测试实例 2' })
    .click();
  await expect(
    page.getByRole('tab', { name: '模组诊断', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '扩展模组检查', exact: true }),
  ).toHaveCount(0);
  checks.push(
    'instance-overview-entry',
    'instance-tab-entry',
    'real-host-mod-check',
    'other-instance-unaffected',
  );
  await extensions();
  await install(path.join(project, 'docs/plugins/compact.ecplugin.json'));
  await expect(
    page.getByRole('heading', { name: '轻巧工作区', exact: true }),
  ).toBeVisible();
  await page.getByRole('switch', { name: '启用', exact: true }).click();
  await expect(page.locator('.native-library')).toHaveAttribute(
    'data-layout',
    'compact',
  );
  const theme = {
    schemaVersion: 1,
    id: 'test.native-theme',
    name: '桌面测试主题',
    version: '1.0.0',
    type: 'theme',
    settings: { theme: 'grass', accentColor: '#388967' },
  };
  const themePath = path.join(output, 'theme.json');
  await writeFile(themePath, JSON.stringify(theme));
  await install(themePath);
  await expect(
    page.getByRole('heading', { name: theme.name, exact: true }),
  ).toBeVisible();
  await page.getByRole('switch', { name: '启用', exact: true }).click();
  await expect(page.locator('.native-library')).toHaveAttribute(
    'data-theme',
    'grass',
  );
  await expect(page.locator('.native-library')).toHaveAttribute(
    'data-layout',
    'compact',
  );
  await expect(
    page.getByRole('switch', { name: '启用', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('switch', { name: '启用', exact: true }),
  ).toBeChecked();
  await pause(250);
  await page.screenshot({ path: path.join(output, 'appearance-1120.png') });
  checks.push('theme-layout-coexistence', 'legacy-package-conversion');
  await install(jsonFile);
  await expect(
    page.getByRole('alert').filter({ hasText: '此插件已安装' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭插件错误', exact: true }).click();
  const invalidPath = path.join(output, 'bad.json');
  await writeFile(
    invalidPath,
    JSON.stringify({
      ...JSON.parse(await readFile(jsonFile, 'utf8')),
      script: 'throw Error()',
    }),
  );
  await install(invalidPath);
  await expect(
    page.getByRole('alert').filter({ hasText: /插件声明字段无效/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭插件错误', exact: true }).click();
  checks.push('duplicate-import-rejected', 'executable-payload-rejected');
  await page.getByRole('button', { name: /^我的工具/ }).click();
  await page.getByRole('button', { name: /^JSON 工具/ }).click();
  await expect(
    page.getByRole('textbox', { name: 'JSON 输入', exact: true }),
  ).toHaveValue(/hello/);
  await expect(
    page.getByRole('textbox', { name: 'JSON 结果', exact: true }),
  ).toHaveValue(/世界/);
  const updated = JSON.parse(await readFile(jsonFile, 'utf8'));
  updated.version = '1.1.0';
  const updatePath = path.join(output, 'updated.json');
  await writeFile(updatePath, JSON.stringify(updated));
  await install(updatePath);
  await expect(
    page.getByRole('dialog', { name: '替换本地插件', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('inputs-and-results-survive-navigation', 'explicit-local-update');
  const brokenUpdate = {
    ...updated,
    version: '2.0.0',
    dependencies: { 'missing.required-plugin': '1.0.0' },
  };
  const brokenUpdatePath = path.join(output, 'broken-update.json');
  await writeFile(brokenUpdatePath, JSON.stringify(brokenUpdate));
  await install(brokenUpdatePath);
  await page.getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /缺少依赖/ })
      .first(),
  ).toBeVisible();
  const retained = JSON.parse(
    await readFile(path.join(data, 'plugins/registry.json'), 'utf8'),
  );
  assert.equal(
    retained.packages.find((p) => p.manifest.id === updated.id).manifest
      .version,
    '1.1.0',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.getByRole('button', { name: '关闭插件错误', exact: true }).click();
  checks.push('failed-update-keeps-active-old-package');
  await page
    .getByRole('button', { name: '停用第三方插件', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '退出恢复模式', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '格式化', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '退出恢复模式', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '格式化', exact: true }),
  ).toBeEnabled();
  await resize(800, 540);
  await pause(250);
  await page.screenshot({ path: path.join(output, 'tool-800.png') });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: /^界面外观/ }).click();
  await page.getByRole('button', { name: /^我的工具/ }).click();
  assert.equal(
    await page.locator('.extension-groups button[aria-expanded=true]').count(),
    1,
  );
  checks.push('recovery-mode', 'minimum-window', 'reduced-motion');
  await resize(1120, 720);
  await pause(250);
  await page.screenshot({ path: path.join(output, 'tool-1120.png') });
  const registry = JSON.parse(
    await readFile(path.join(data, 'plugins/registry.json'), 'utf8'),
  );
  const record = registry.packages.find((p) => p.manifest.id === updated.id);
  const userOutput = path.join(
    data,
    'plugins/user-data',
    updated.id,
    'report.txt',
  );
  await mkdir(path.dirname(userOutput), { recursive: true });
  await writeFile(userOutput, 'retained user artifact');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'JSON 工具 已进入回收站' }),
  ).toBeVisible();
  await assert.rejects(access(path.join(data, record.file)));
  const recycled = await command([
    '-NoProfile',
    '-File',
    'scripts/check-plugin-test-recycle.ps1',
    '-ManagedPackage',
    path.join(data, record.file),
  ]);
  assert.equal(
    recycled.trim(),
    'true',
    'Package must actually be present in the Windows Recycle Bin',
  );
  assert.equal(await readFile(userOutput, 'utf8'), 'retained user artifact');
  const after = JSON.parse(
    await readFile(path.join(data, 'plugins/registry.json'), 'utf8'),
  );
  assert(!after.packages.some((p) => p.manifest.id === updated.id));
  assert(after.states[updated.id]);
  checks.push(
    'real-recycle-bin-delete',
    'configuration-and-user-output-retained',
  );
  await page.reload();
  await extensions();
  await expect(page.getByRole('button', { name: /^我的工具/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: '插件下载', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '插件目录尚未开放', exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      { passed: true, data, syntheticInstances: true, checks, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, output, checks }));
} catch (e) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  if (page)
    console.error((await page.locator('body').innerText()).slice(-3500));
  throw e;
} finally {
  await browser?.close();
  app.kill();
}
