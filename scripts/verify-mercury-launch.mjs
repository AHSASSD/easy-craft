// Real launcher smoke test, isolated copy only. Never open a personal world.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd();
const source = path.join(project, 'src-tauri/target/debug/data');
const data =
  process.env.EASYCRAFT_MERCURY_REUSE ||
  path.join(project, '.native/launch-smoke/mercury-' + randomUUID());
assert(
  path
    .resolve(data)
    .startsWith(path.join(project, '.native/launch-smoke') + path.sep),
);
const output = path.join(project, 'output/playwright/launch-smoke/mercury');
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
const instance = JSON.parse(
  await readFile(
    path.join(
      process.env.EASYCRAFT_MERCURY_REUSE ? data : source,
      'instances.json',
    ),
  ),
).find((v) => v.name.includes('Mercury') || v.name.includes('水星'));
assert(instance);
for (const folder of process.env.EASYCRAFT_MERCURY_REUSE
  ? []
  : ['assets', 'libraries', 'versions', 'instances/' + instance.id]) {
  await cp(path.join(source, folder), path.join(data, folder), {
    recursive: true,
    filter: (file) =>
      !/(?:^|[\\/])(?:saves|screenshots|logs|crash-reports)(?:[\\/]|$)/.test(
        file,
      ),
  });
}
instance.local.root = data;
instance.launch = {
  ...instance.launch,
  javaPath: path.resolve(
    project,
    '../build-tools/easycraft/java8/jdk8u504-b01-jre/bin/java.exe',
  ),
  windowMode: 'windowed',
};
await writeFile(path.join(data, 'instances.json'), JSON.stringify([instance]));
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: instance.launch.javaPath,
    memoryMb: 8192,
    memoryMode: 'manual',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'InstallCheck',
    isolateNewInstances: true,
  }),
);
const call = (file, args) =>
  new Promise((ok, fail) =>
    execFile(file, args, { windowsHide: true, timeout: 30000 }, (e, s) =>
      e ? fail(e) : ok(s),
    ),
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const app = spawn(
  path.join(project, 'src-tauri/target/debug/easy-craft.exe'),
  [],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
    stdio: 'ignore',
  },
);
let browser, page;
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
  page = browser.contexts()[0].pages()[0];
  await page.locator('.library-shell').waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  const report = await invoke('native_mod_check', {
    id: instance.id,
    force: true,
  });
  await writeFile(
    path.join(output, 'mod-report.json'),
    JSON.stringify(report, null, 2),
  );
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  const gameLogPath = path.join(
    data,
    instance.local.gameDirectory,
    'logs/latest.log',
  );
  await mkdir(path.dirname(gameLogPath), { recursive: true });
  await writeFile(gameLogPath, '');
  await invoke('native_launch', { id: instance.id });
  let last = '',
    state,
    log = '';
  for (let i = 0; i < 900; i++) {
    state = await invoke('native_status');
    if (state.task.message !== last) {
      console.log(state.task.message);
      last = state.task.message;
    }
    if (state.task.status === 'failed' || state.task.status === 'succeeded') {
      await writeFile(
        path.join(output, 'failed-task.json'),
        JSON.stringify(state.task, null, 2),
      );
      throw Error(state.task.message);
    }
    log = await readFile(
      path.join(data, instance.local.gameDirectory, 'logs/latest.log'),
      'utf8',
    ).catch(() => '');
    if (
      state.task.pid &&
      /Forge Mod Loader has successfully loaded/.test(log) &&
      /Sound engine started/.test(log)
    ) {
      await pause(20000);
      state = await invoke('native_status');
      assert(
        state.task.pid && state.task.status === 'running',
        'Game exited before capture',
      );
      break;
    }
    await pause(1000);
    if (i === 899) throw Error('Game menu timeout');
  }
  await writeFile(path.join(output, 'latest.log'), log);
  const screenshot = path.join(output, 'menu.png');
  await call('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/capture-test-game.ps1'),
    '-GameProcessId',
    String(state.task.pid),
    '-LauncherProcessId',
    String(app.pid),
    '-JavaPath',
    instance.launch.javaPath,
    '-Sandbox',
    data,
    '-GameDirectory',
    path.join(data, instance.local.gameDirectory),
    '-Screenshot',
    screenshot,
  ]);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        data,
        pid: state.task.pid,
        reportIssues: report.issues.length,
        screenshot,
      },
      null,
      2,
    ),
  );
  console.log('Captured game window: ' + screenshot);
  await invoke('native_cancel');
} finally {
  if (page)
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('native_cancel'))
      .catch(() => {});
  await browser?.close();
  app.kill();
}
