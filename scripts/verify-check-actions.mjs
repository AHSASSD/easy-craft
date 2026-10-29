// Authorized real Mod metadata, read-only source and isolated launcher data. No game launch.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readdir, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const recorded = JSON.parse(
  await readFile(
    path.join(project, '.native/mod-check-real-report.json'),
    'utf8',
  ),
);
const data = path.join(project, '.native/check-actions-desktop', randomUUID());
const output = path.join(project, 'output/playwright/check-actions');
await mkdir(data, { recursive: true });
await mkdir(output, { recursive: true });
const source = recorded.source;
const root = path.dirname(path.dirname(source));
const relative = path.relative(root, source).replaceAll('\\', '/');
const original = {
  id: 'nightfall-review',
  name: 'Fear Nightfall · real instance',
  version: '1.20.1',
  manifestSha1: 'a'.repeat(40),
  javaMajor: 17,
  fabricVersion: '',
  fabricSha1: '',
  local: {
    root,
    versionDirectory: relative,
    gameDirectory: relative,
    clientJar: relative + '/Fear_Nightfall_Remains_of_Chaos.jar',
    sourceKey: 'a'.repeat(64),
    loader: 'forge',
    loaderVersion: recorded.loaderVersion,
  },
};
const mirror = {
  ...original,
  id: 'nightfall-mirror',
  name: 'Nightfall · isolated verification',
  local: {
    ...original.local,
    root: recorded.mirror,
    versionDirectory: '',
    gameDirectory: '',
    clientJar: 'not-launched.jar',
    sourceKey: 'b'.repeat(64),
  },
};
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([original, mirror]),
);
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: '',
    memoryMb: 2048,
    memoryMode: 'auto',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'UIReview',
    isolateNewInstances: true,
  }),
);
const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
  },
);
let browser, page;
const errors = [],
  checks = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const shot = (name) =>
  page.screenshot({
    path: path.join(output, name + '.png'),
    animations: 'disabled',
  });
async function tab(name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await pause(250);
}
async function resize(width, height, capture) {
  await command('powershell.exe', [
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
    ...(capture ? ['-Screenshot', path.join(output, capture + '.png')] : []),
  ]);
}
async function bounds() {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    contentOverflow: [...document.querySelectorAll('.instance-manager')].some(
      (e) => e.scrollWidth > e.clientWidth + 2,
    ),
  }));
  assert(!result.overflow && !result.contentOverflow, JSON.stringify(result));
  return result;
}
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
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.library-shell').waitFor();
  await resize(1120, 720);
  await page
    .locator('.library-instance')
    .filter({ hasText: 'Fear Nightfall' })
    .click();
  await page.getByRole('heading', { name: '常用操作' }).waitFor();
  await shot('01-overview-dark');
  await bounds();
  await page.locator('.preflight-summary').click();
  await page.getByText(/个归档，重读/).waitFor();
  await shot('02-real-report-dark');
  const before = await invoke('native_mod_check', { id: 'nightfall-mirror' });
  const forced = await invoke('native_mod_check', {
    id: 'nightfall-mirror',
    force: true,
  });
  assert.equal(forced.details.parsedFiles, recorded.count);
  await page.keyboard.press('Escape');
  const testFile = path.join(recorded.mirror, 'mods', recorded.removedFile);
  const heldFile = testFile + '.ui-check-disabled';
  await rename(testFile, heldFile);
  try {
    const missing = await invoke('native_mod_check', {
      id: 'nightfall-mirror',
    });
    assert(
      missing.issues.some((issue) =>
        issue.includes('缺少必需依赖：puzzleslib'),
      ),
    );
    await page
      .locator('.library-instance')
      .filter({ hasText: 'isolated verification' })
      .click();
    await page
      .locator('.preflight-summary')
      .filter({ hasText: `${missing.issues.length} 项` })
      .waitFor();
    await page.locator('.preflight-summary').click();
    await page
      .getByText(/缺少必需依赖：puzzleslib/)
      .first()
      .waitFor();
    await shot('03-missing-required-real-mod');
    await page.keyboard.press('Escape');
    checks.push({
      check: 'Real desktop reports missing PuzzlesLib in isolated copy',
      issues: missing.issues.length,
      additional: missing.issues.length - before.issues.length,
    });
  } finally {
    await rename(heldFile, testFile);
  }
  const restored = await invoke('native_mod_check', { id: 'nightfall-mirror' });
  assert.deepEqual(restored.issues, before.issues);
  await tab('截图');
  await tab('概览');
  const warm = await invoke('native_mod_check', { id: 'nightfall-mirror' });
  assert.equal(warm.details.parsedFiles, 0);
  // Actual folder routing for all scopes, without opening personal Explorer windows.
  await invoke('native_instance_folder_open', {
    id: 'nightfall-mirror',
    folder: 'saves',
  }).then(
    () => {
      throw Error('Missing directory unexpectedly opened');
    },
    (error) => assert(String(error).includes('尚未生成')),
  );
  assert.equal((await readdir(recorded.mirror)).includes('saves'), false);
  const uiState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('easycraft.preferences.v1')),
  );
  assert(uiState);
  for (const scale of [100, 125, 150]) {
    await resize(1120, 720);
    await page.evaluate(
      ({ uiState, scale }) =>
        localStorage.setItem(
          'easycraft.preferences.v1',
          JSON.stringify({ ...uiState, uiScale: scale }),
        ),
      { uiState, scale },
    );
    await page.reload();
    await page.locator('.library-shell').waitFor();
    await pause(500);
    await bounds();
    await shot('overview-scale-' + scale);
    await resize(800, 540, 'minimum-native-' + scale);
    await bounds();
  }
  await resize(800, 540);
  await bounds();
  await shot('03-minimum');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('easycraft.preferences.v1'));
    localStorage.setItem(
      'easycraft.preferences.v1',
      JSON.stringify({ ...p, theme: 'grass', uiScale: 100 }),
    );
  });
  await resize(1120, 720);
  await page.reload();
  await page.locator('.library-shell').waitFor();
  await pause(500);
  await bounds();
  await shot('04-overview-light');
  const state = await invoke('native_status');
  assert.equal(state.task.pid, null);
  assert.notEqual(state.task.status, 'running');
  assert.equal(errors.length, 0, errors.join('\n'));
  checks.push({
    check:
      'Real desktop reference, automatic report, forced re-read, cached verification, unsupported scope, missing folder and themes/scales',
    before: before.details,
    forced: forced.details,
    warm: warm.details,
  });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        data,
        source,
        checks,
        errors,
        noMinecraftLaunched: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks, null, 2));
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
