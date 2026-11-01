// Explicit user-requested real pack test. Originals and account files are never written.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdir,
  readFile,
  writeFile,
  cp,
  readdir,
  lstat,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd();
const original = 'E:/minecraft/versions/苍蓝天鹅绒的彼端';
const testRoot = path.join(project, '.native/launch-smoke/azure');
const data = path.join(testRoot, 'launcher-data');
const sandbox = path.join(testRoot, 'minecraft');
const game = path.join(sandbox, 'versions/苍蓝天鹅绒的彼端');
const output = path.join(project, 'output/playwright/launch-smoke/azure');
const java = path.resolve(
  project,
  '../build-tools/easycraft/java21/jdk-21.0.12.1+1-jre/bin/java.exe',
);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const command = (file, args) =>
  new Promise((ok, fail) =>
    execFile(file, args, { windowsHide: true, timeout: 60000 }, (e, s) =>
      e ? fail(e) : ok(s),
    ),
  );
async function snapshot(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      assert(!(await lstat(file)).isSymbolicLink());
      if (entry.isDirectory()) await visit(file);
      else
        result.push([
          path.relative(root, file),
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ]);
    }
  }
  await visit(root);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
await writeFile(
  path.join(data, 'instances.json'),
  await readFile(path.join(data, 'instances.json'), 'utf8').catch(() => '[]'),
);
const before = await snapshot(original);
await writeFile(
  path.join(output, 'source-before.json'),
  JSON.stringify(before),
);
if (!process.env.EASYCRAFT_AZURE_REUSE) {
  await mkdir(game, { recursive: true });
  for (const folder of ['libraries', 'assets']) {
    console.log('Copy immutable ' + folder);
    await cp('E:/minecraft/' + folder, path.join(sandbox, folder), {
      recursive: true,
    });
  }
  for (const name of [
    '苍蓝天鹅绒的彼端.json',
    '苍蓝天鹅绒的彼端.jar',
    'mods',
    'config',
    'defaultconfigs',
    'resourcepacks',
    'saves',
    'options.txt',
  ])
    await cp(path.join(original, name), path.join(game, name), {
      recursive: true,
    });
  await writeFile(path.join(data, 'instances.json'), '[]');
}
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: java,
    memoryMb: 6144,
    memoryMode: 'manual',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'LaunchTest',
    isolateNewInstances: true,
  }),
);
// Reuse the existing native picker harness with its allowlist narrowed to this exact sandbox.
const picker = (
  await readFile(path.join(project, 'scripts/select-native-file.ps1'), 'utf8')
)
  .replace(
    '$project = Split-Path $PSScriptRoot -Parent',
    "$project = '" + project.replaceAll("'", "''") + "'",
  )
  .replace(
    "(Join-Path $project '.native/fixtures')",
    "(Join-Path $project '.native/launch-smoke/azure/minecraft')",
  );
const pickerPath = path.join(output, 'select-sandbox.ps1');
await writeFile(pickerPath, '\ufeff' + picker);
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
  let state = await invoke('native_status');
  if (!state.instances.length) {
    const pending = invoke('native_local_scan_pick');
    pending.catch(() => {});
    await command('powershell.exe', [
      '-NoProfile',
      '-File',
      pickerPath,
      '-AppProcessId',
      String(app.pid),
      '-File',
      game,
      '-Directory',
    ]);
    const preview = await pending;
    await writeFile(
      path.join(output, 'scan.json'),
      JSON.stringify(preview, null, 2),
    );
    console.log('Scan:', JSON.stringify(preview));
    assert.equal(preview.candidates.length, 1);
    assert(preview.candidates[0].supported);
    await invoke('native_local_import', {
      token: preview.token,
      selected: [
        {
          id: preview.candidates[0].id,
          name: '苍蓝天鹅绒的彼端',
          mode: 'reference',
        },
      ],
    });
    for (let i = 0; i < 120; i++) {
      state = await invoke('native_status');
      if (['failed', 'succeeded'].includes(state.task.status)) break;
      await pause(500);
    }
    await writeFile(
      path.join(output, 'import.json'),
      JSON.stringify(state, null, 2),
    );
    assert.equal(state.task.status, 'succeeded', state.task.message);
  }
  const instance = state.instances[0];
  assert(instance);
  const report = await invoke('native_mod_check', {
    id: instance.id,
    force: true,
  });
  await writeFile(
    path.join(output, 'mod-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('Preflight:', JSON.stringify(report.issues));
  await page.screenshot({ path: path.join(output, 'imported.png') });
  await mkdir(path.join(game, 'logs'), { recursive: true });
  await writeFile(path.join(game, 'logs/latest.log'), '');
  await invoke('native_launch', { id: instance.id });
  let last = '';
  let ready = false;
  for (let i = 0; i < 600; i++) {
    state = await invoke('native_status');
    if (state.task.message !== last) {
      console.log(state.task.message);
      last = state.task.message;
    }
    await writeFile(
      path.join(output, 'task.json'),
      JSON.stringify(state.task, null, 2),
    );
    if (['failed', 'succeeded', 'cancelled'].includes(state.task.status))
      throw Error(state.task.message);
    const log = await readFile(
      path.join(game, 'logs/latest.log'),
      'utf8',
    ).catch(() => '');
    if (state.task.pid && /Sound engine started/.test(log)) {
      await pause(20000);
      ready = true;
      break;
    }
    await pause(1000);
  }
  assert(ready, 'Game did not reach render/audio initialization');
  state = await invoke('native_status');
  assert.equal(state.task.status, 'running');
  console.log(
    await command('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(state.task.pid)}' | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='SandboxInCommand';e={$_.CommandLine.Contains('${testRoot.replaceAll("'", "''")}')}} | ConvertTo-Json`,
    ]),
  );
  await command('powershell.exe', [
    '-NoProfile',
    '-File',
    path.join(project, 'scripts/capture-test-game.ps1'),
    '-GameProcessId',
    String(state.task.pid),
    '-LauncherProcessId',
    String(app.pid),
    '-JavaPath',
    java,
    '-Sandbox',
    testRoot,
    '-GameDirectory',
    game,
    '-Screenshot',
    path.join(output, 'menu.png'),
  ]);
  if (process.env.EASYCRAFT_AZURE_WORLD) {
    const capture = (name, x, y) =>
      command('powershell.exe', [
        '-NoProfile',
        '-File',
        path.join(project, 'scripts/capture-test-game.ps1'),
        '-GameProcessId',
        String(state.task.pid),
        '-LauncherProcessId',
        String(app.pid),
        '-JavaPath',
        java,
        '-Sandbox',
        testRoot,
        '-GameDirectory',
        game,
        '-Screenshot',
        path.join(output, name + '.png'),
        ...(x === undefined
          ? []
          : ['-ClickX', String(x), '-ClickY', String(y)]),
      ]);
    await capture('world-list', 0.5, 0.425);
    console.log('Captured world list');
    await pause(25000);
    await capture('world-selected', 0.4, 0.27);
    await capture('world-loading', 0.32, 0.825);
    await pause(30000);
    await capture('world');
    const worldLog = await readFile(path.join(game, 'logs/latest.log'), 'utf8');
    await writeFile(path.join(output, 'world-latest.log'), worldLog);
    assert(
      /Preparing spawn area|Preparing start region|joined the game|加入了游戏/.test(
        worldLog,
      ),
      'World loading not confirmed by server log',
    );
  }
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        data,
        game,
        pid: state.task.pid,
        reportIssues: report.issues,
        originalUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log('Captured menu');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (page)
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('native_cancel'))
      .catch(() => {});
  await browser?.close();
  app.kill();
  assert.deepEqual(await snapshot(original), before, 'Original pack changed');
  console.log('Original files unchanged');
}
