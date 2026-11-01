// Read-only compatibility checks of the two user-requested installed modpacks.
// This deliberately does not count as a fresh archive download/install test.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const project = process.cwd();
const label = randomUUID();
const data = path.join(project, '.native/chinese-packs', label);
const output = path.join(project, 'output/playwright/chinese-packs', label);
const cases = [
  {
    name: '落幕曲',
    directory: 'C:/Users/小萌新一只/AppData/Roaming/.minecraft/versions/落幕曲',
    loader: 'forge',
  },
  {
    name: '你好，新蒸程V1.5.9',
    directory: 'E:/minecraft/versions/你好，新蒸程V1.5.9',
    loader: 'neoforge',
  },
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(data, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(data, 'instances.json'), '[]');
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: '',
    memoryMb: 4096,
    memoryMode: 'manual',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'PackTest',
    isolateNewInstances: true,
  }),
);
async function fingerprints(directory) {
  const names = (await readdir(directory)).filter(
    (name) => /\.(json|jar)$/.test(name) || name === 'options.txt',
  );
  names.push(
    ...(await readdir(path.join(directory, 'mods')))
      .filter((name) => /\.jar$/.test(name))
      .map((name) => 'mods/' + name),
  );
  const result = [];
  for (const name of names.sort()) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path.join(directory, name)))
      hash.update(bytes);
    result.push([name, hash.digest('hex')]);
  }
  return result;
}
// Keep the native picker automation bound to this workspace process and these
// two exact source directories; allow no other newly selected personal path.
let picker = await readFile(
  path.join(project, 'scripts/select-native-file.ps1'),
  'utf8',
);
picker = picker.replace(
  '$project = Split-Path $PSScriptRoot -Parent',
  "$project = '" + project.replaceAll("'", "''") + "'",
);
picker = picker.replace(
  /\$userScan = [^\r\n]*/,
  "$userScan = $Directory -and (@('" +
    cases
      .map((row) => path.resolve(row.directory).replaceAll("'", "''"))
      .join("','") +
    "') -contains $selected)",
);
const pickerPath = path.join(output, 'select-requested-pack.ps1');
await writeFile(pickerPath, '\ufeff' + picker);
const select = (directory, pid) =>
  new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        pickerPath,
        '-AppProcessId',
        String(pid),
        '-File',
        directory,
        '-Directory',
      ],
      { windowsHide: true, timeout: 60000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
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
      EASYCRAFT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
  },
);
let browser;
const results = [];
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
  assert(browser, 'Native launcher CDP did not become ready');
  const page = browser.contexts()[0].pages()[0];
  await page.locator('.library-shell').waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  for (const [index, row] of cases.entries()) {
    console.log('Checking ' + row.name);
    const before = await fingerprints(row.directory);
    const started = performance.now();
    const pending = invoke('native_local_scan_pick');
    pending.catch(() => {});
    await select(row.directory, app.pid);
    const scan = await pending;
    const scanMsIncludingPicker = Math.round(performance.now() - started);
    await writeFile(
      path.join(output, index + '-scan.json'),
      JSON.stringify(scan, null, 2),
    );
    assert.equal(scan.candidates.length, 1);
    const candidate = scan.candidates[0];
    assert(candidate.supported, JSON.stringify(candidate));
    assert(
      candidate.loader.toLowerCase().startsWith(row.loader + ' '),
      candidate.loader,
    );
    assert(candidate.sourceIsolation);
    const importStarted = performance.now();
    await invoke('native_local_import', {
      token: scan.token,
      selected: [{ id: candidate.id, name: row.name, mode: 'reference' }],
    });
    let state;
    for (let i = 0; i < 240; i++) {
      state = await invoke('native_status');
      if (['succeeded', 'failed', 'cancelled'].includes(state.task.status))
        break;
      await pause(100);
    }
    assert.equal(state.task.status, 'succeeded', state.task.message);
    const importMs = Math.round(performance.now() - importStarted);
    const instance = state.instances.find((item) => item.name === row.name);
    assert(instance);
    assert.equal(instance.local.loader, row.loader);
    assert.equal(
      path.resolve(instance.local.root, instance.local.gameDirectory),
      path.resolve(row.directory),
    );
    const report = await invoke('native_mod_check', {
      id: instance.id,
      force: true,
    });
    assert.deepEqual(
      report.issues,
      [],
      'Known-good installed pack has a declared dependency warning',
    );
    assert(
      !report.unchecked.some((message) =>
        message.includes('声明条目超过 512 KiB'),
      ),
    );
    const cached = await invoke('native_mod_check', {
      id: instance.id,
      force: false,
    });
    assert.deepEqual(cached.issues, report.issues);
    await page
      .locator('.library-instance')
      .filter({ hasText: row.name })
      .click();
    await pause(750);
    await page.screenshot({ path: path.join(output, index + '-imported.png') });
    const duplicatePending = invoke('native_local_scan_pick');
    duplicatePending.catch(() => {});
    await select(row.directory, app.pid);
    const duplicate = await duplicatePending;
    assert(duplicate.candidates[0].duplicate);
    assert.equal((await invoke('native_status')).instances.length, index + 1);
    const after = await fingerprints(row.directory);
    assert.deepEqual(
      after,
      before,
      'Source versions/mods/options were changed',
    );
    const result = {
      name: row.name,
      directory: row.directory,
      testType: 'existing-installation-reference-import',
      scanMsIncludingPicker,
      importMs,
      candidate,
      instance,
      report,
      cachedDetails: cached.details,
      duplicateRejected: true,
      unchangedSha256Files: before.length,
    };
    results.push(result);
    await writeFile(
      path.join(output, 'results.json'),
      JSON.stringify(results, null, 2),
    );
    console.log(
      JSON.stringify({
        name: row.name,
        importMs,
        details: report.details,
        issues: report.issues,
        uncheckedCount: report.unchecked.length,
        unchangedFiles: before.length,
      }),
    );
  }
} finally {
  await browser?.close().catch(() => {});
  app.kill();
}
console.log('Reports: ' + output);
