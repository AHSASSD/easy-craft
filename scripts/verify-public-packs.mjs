// Real online installation regression; uses isolated catalogs, never personal accounts/worlds.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  link,
  lstat,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
const project = process.cwd();
const baseline = process.argv.includes('--baseline');
const label =
  process.env.EASYCRAFT_PACK_TEST_LABEL || (baseline ? 'before' : 'after');
assert(/^[a-z0-9-]{1,60}$/.test(label));
const data = path.join(project, '.native/public-packs', label);
const output = path.join(project, 'output/playwright/public-packs', label);
const source = process.env.EASYCRAFT_PACK_TEST_CACHE_SOURCE
  ? path.resolve(process.env.EASYCRAFT_PACK_TEST_CACHE_SOURCE)
  : path.join(project, 'src-tauri/target/debug/data');
assert(source.startsWith(project + path.sep));
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
// Immutable verified cache entries are hard linked, not game data. Atomic cache
// replacement unlinks our own entry; no account/catalog/config file is shared.
async function seed(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name),
      b = path.join(to, entry.name);
    assert(!(await lstat(a)).isSymbolicLink());
    if (entry.isDirectory()) await seed(a, b);
    else if (!entry.name.endsWith('.part'))
      await link(a, b).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
  }
}
for (const folder of [
  'versions',
  'libraries',
  'assets',
  'loaders',
  'pack-cache',
  'pack-archives',
])
  if (
    !process.env.EASYCRAFT_PACK_TEST_COLD_CONTENT ||
    !['pack-cache', 'pack-archives'].includes(folder)
  )
    await seed(path.join(source, folder), path.join(data, folder));
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: process.env.EASYCRAFT_PACK_TEST_JAVA ?? '',
    memoryMb: 4096,
    memoryMode: 'manual',
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'PackTest',
    isolateNewInstances: true,
  }),
);
const defaultCases = [
  {
    project: '1KVo5zza',
    version: 'N276l2ON',
    filename: 'Fabulously.Optimized-v6.5.0.mrpack',
    name: '6.5.0 for 1.21.1',
  },
  {
    project: '5FFgwNNP',
    version: 'YQpPe5Iu',
    filename: 'Cobblemon Official Modpack [Fabric] 1.8.4.mrpack',
    name: 'Cobblemon Official Modpack [Fabric] 1.8.4',
  },
];
const cases = process.env.EASYCRAFT_PACK_TEST_CASES
  ? JSON.parse(
      (await readFile(process.env.EASYCRAFT_PACK_TEST_CASES, 'utf8')).replace(
        /^\ufeff/,
        '',
      ),
    )
  : defaultCases;
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, page;
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
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  await page.locator('.library-shell').waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  for (const pack of cases) {
    console.log('INSTALL ' + pack.name);
    let preview = pack.forgeLoader
      ? null
      : await invoke('native_pack_online', {
          project: pack.project,
          version: pack.version,
          filename: pack.filename,
        });
    await writeFile(
      path.join(output, pack.version + '-preview.json'),
      JSON.stringify(preview, null, 2),
    );
    if (!pack.forgeLoader && !preview.install) {
      results.push({
        name: pack.name,
        status: 'unavailable',
        warnings: preview.warnings,
      });
      continue;
    }
    const started = Date.now();
    const previousIds = new Set(
      (await invoke('native_status')).instances.map((v) => v.id),
    );
    const customDestination = process.env.EASYCRAFT_PACK_TEST_CUSTOM_DESTINATION
      ? path.join(project, '.native/fixtures/custom-pack-location', label)
      : null;
    if (customDestination) {
      await mkdir(customDestination, { recursive: true });
      await writeFile(
        path.join(customDestination, 'preserve.txt'),
        'Unrelated existing file',
      );
      const pending = invoke('native_pack_destination', {
        token: preview.install.token,
      });
      pending.catch(() => {});
      await new Promise((resolve, reject) =>
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-File',
            path.join(project, 'scripts/select-native-file.ps1'),
            '-AppProcessId',
            String(app.pid),
            '-File',
            customDestination,
            '-Directory',
          ],
          { windowsHide: true, timeout: 60000 },
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      assert.equal(
        path.resolve(await pending),
        path.resolve(customDestination),
      );
    }
    if (pack.forgeLoader) {
      await invoke('native_forge_install', {
        game: pack.game,
        name: pack.name,
        loader: pack.forgeLoader,
      });
    } else
      await invoke('native_pack_install', {
        token: preview.install.token,
        name: 'Regression ' + pack.name.slice(0, 40),
        selected: [],
      });
    let last = '',
      state;
    const phases = [];
    let capturedDownload = false;
    for (let i = 0; i < 1200; i++) {
      state = await invoke('native_status');
      if (phases.at(-1)?.phase !== state.task.phase)
        phases.push({
          phase: state.task.phase,
          elapsedMs: Date.now() - started,
        });
      if (state.task.message !== last) {
        console.log(state.task.message);
        last = state.task.message;
      }
      if (state.task.status !== 'running') break;
      if (
        process.env.EASYCRAFT_PACK_TEST_CAPTURE_PROGRESS &&
        !capturedDownload &&
        state.task.phase === 'pack-download' &&
        state.task.completed > 0
      ) {
        if (process.env.EASYCRAFT_PACK_TEST_WORKSPACE) {
          await page.locator('.pending-install').click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('.page-content .task-steps li')
                .length >= 5,
          );
          await page.screenshot({
            path: path.join(output, pack.version + '-workspace-progress.png'),
          });
        }
        await page
          .getByRole('button', { name: '任务与日志', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: '任务与日志',
          exact: true,
        });
        await dialog.waitFor();
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll('.task-steps progress')).some(
              (p) => Number(p.value) > 0,
            ),
          undefined,
          { timeout: 10000 },
        );
        assert((await dialog.textContent()).includes('MiB'));
        assert(
          await dialog
            .getByRole('button', { name: '取消任务', exact: true })
            .isEnabled(),
        );
        await page.screenshot({
          path: path.join(output, pack.version + '-download.png'),
        });
        if (process.env.EASYCRAFT_PACK_TEST_CANCEL_DOWNLOAD) {
          await dialog
            .getByRole('button', { name: '取消任务', exact: true })
            .click();
          let cancelled;
          for (let attempt = 0; attempt < 100; attempt++) {
            cancelled = await invoke('native_status');
            if (cancelled.task.status !== 'running') break;
            await pause(100);
          }
          assert.equal(cancelled.task.status, 'cancelled');
          assert.deepEqual(
            cancelled.instances.map((v) => v.id).sort(),
            [...previousIds].sort(),
          );
          const cacheFiles = await readdir(path.join(data, 'pack-cache'));
          await writeFile(
            path.join(output, pack.version + '-cancelled.json'),
            JSON.stringify(
              {
                task: cancelled.task,
                partialFiles: cacheFiles.filter((v) => v.endsWith('.part')),
                verifiedFiles: cacheFiles.filter((v) => v.endsWith('.data'))
                  .length,
              },
              null,
              2,
            ),
          );
          preview = await invoke('native_pack_online', {
            project: pack.project,
            version: pack.version,
            filename: pack.filename,
          });
          assert(preview.install);
          await invoke('native_pack_install', {
            token: preview.install.token,
            name: 'Regression ' + pack.name.slice(0, 40),
            selected: [],
          });
        }
        await dialog
          .getByRole('button', { name: '关闭弹窗', exact: true })
          .click();
        capturedDownload = true;
      }
      await pause(1000);
    }
    const result = {
      name: pack.name,
      status: state.task.status,
      message: state.task.message,
      elapsedMs: Date.now() - started,
      phases,
      task: state.task,
      instances: state.instances,
    };
    if (state.task.status === 'succeeded') {
      const installed = state.instances.filter((v) => !previousIds.has(v.id));
      assert.equal(installed.length, 1);
      if (pack.expectedLoader)
        assert.equal(installed[0].local?.loader, pack.expectedLoader);
      const library = installed[0].storageRoot ?? data;
      const minecraft =
        path.basename(library).toLowerCase() === '.minecraft'
          ? library
          : path.join(library, '.minecraft');
      const directory = installed[0].versionFolder
        ? path.join(minecraft, 'versions', installed[0].versionFolder)
        : path.join(library, 'instances', installed[0].id);
      const game = installed[0].versionFolder
        ? directory
        : path.join(directory, 'game');
      if (customDestination) {
        assert.equal(
          path.resolve(installed[0].storageRoot),
          path.resolve(customDestination),
        );
        assert.equal(
          await readFile(path.join(customDestination, 'preserve.txt'), 'utf8'),
          'Unrelated existing file',
        );
        assert(
          !(await access(
            path.join(data, 'instances', installed[0].id, 'game'),
          ).then(
            () => true,
            () => false,
          )),
        );
      }
      if (pack.forgeLoader) {
        assert.equal(installed[0].version, pack.game);
        assert.equal(installed[0].local.loader, 'forge');
        assert.equal(installed[0].local.loaderVersion, pack.forgeLoader);
        await access(path.join(directory, 'local-profile.json'));
        await access(game);
      } else {
        const provenance = JSON.parse(
          await readFile(path.join(game, '.easycraft-pack.json'), 'utf8'),
        );
        assert.equal(provenance.archiveSha512, preview.install.archiveSha512);
        assert.equal(
          provenance.files.length,
          preview.install.files.filter((v) => !v.optional).length,
        );
        for (const entry of provenance.files) {
          const actual = createHash('sha512')
            .update(await readFile(path.join(game, entry.path)))
            .digest('hex');
          assert.equal(
            actual,
            entry.sha512,
            `Installed content differs: ${entry.path}`,
          );
        }
        if (pack.project === '5FFgwNNP') {
          await access(
            path.join(game, 'mods/Cobblemon-fabric-1.8.4+1.21.1.jar'),
          );
          await access(
            path.join(
              game,
              'config/yosbr/saves/Tutorial World v4 (1.8)/level.dat',
            ),
          );
          assert(
            !(await access(
              path.join(
                game,
                'config/yosbr/saves/Tutorial World v4 (1.8)/session.lock',
              ),
            ).then(
              () => true,
              () => false,
            )),
          );
        }
      }
    }
    if (
      process.env.EASYCRAFT_TEST_FOLDER_LAYOUT &&
      state.task.status === 'succeeded'
    ) {
      await page
        .getByRole('navigation')
        .getByRole('button', { name: '游戏库', exact: true })
        .click();
      const folder = page.locator('.library-folder').first();
      await folder.locator('summary').waitFor();
      assert(
        (await folder.locator('summary').getAttribute('title')).endsWith(
          '/.minecraft',
        ),
      );
      await folder.locator('summary').click();
      assert.equal(
        await folder.locator('.library-instance').first().isVisible(),
        false,
      );
      await page.locator('.sidebar-search input').fill('Regression');
      await folder.locator('.library-instance').first().waitFor();
      for (const [width, height] of [
        [1120, 720],
        [900, 600],
      ]) {
        await new Promise((resolve, reject) =>
          execFile(
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
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        assert(
          await page
            .locator('.library-instance-list')
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        );
        await page.screenshot({
          path: path.join(output, `library-folders-${width}.png`),
        });
      }
      result.folderCollapseAndSearch = true;
    }
    results.push(result);
    await writeFile(
      path.join(output, pack.version + '-result.json'),
      JSON.stringify(result, null, 2),
    );
    await page.screenshot({ path: path.join(output, pack.version + '.png') });
    console.log(
      'RESULT ' +
        pack.name +
        ' ' +
        state.task.status +
        ' ' +
        state.task.message,
    );
  }
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(results, null, 2),
  );
  if (!baseline)
    assert(
      results.length === cases.length &&
        results.every(
          (r, index) => r.status === (cases[index].expected || 'succeeded'),
        ),
      JSON.stringify(
        results.map((r) => ({
          name: r.name,
          status: r.status,
          message: r.message,
          warnings: r.warnings,
        })),
      ),
    );
} finally {
  if (page)
    await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('native_cancel'))
      .catch(() => {});
  await browser?.close();
  app.kill();
}
