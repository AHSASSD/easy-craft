// Explicitly authorized main-menu smoke tests. Never use the original game directory as cwd.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  lstat,
  readdir,
  rm,
} from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const preparation = JSON.parse(
  await readFile(
    path.join(
      project,
      'output/playwright/local-reference/real-preparation.json',
    ),
    'utf8',
  ),
);
const traceLabel = process.env.EASYCRAFT_DISPLAY_TRACE;
const settleWaitMs = Number(process.env.EASYCRAFT_SMOKE_SETTLE_MS || 12000);
assert(
  Number.isInteger(settleWaitMs) &&
    settleWaitMs >= 12000 &&
    settleWaitMs <= 45000,
);
assert(!traceLabel || /^[a-z0-9-]+$/.test(traceLabel));
const output = path.join(
  project,
  traceLabel
    ? `output/playwright/window-display/${traceLabel}`
    : 'output/playwright/launch-smoke',
);
const data =
  process.env.EASYCRAFT_SMOKE_DATA ||
  path.join(project, '.native/launch-smoke', randomUUID());
assert(
  path
    .resolve(data)
    .startsWith(path.join(project, '.native/launch-smoke') + path.sep),
);
const sandbox = path.join(data, 'minecraft');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) =>
        error ? reject(Error(`${error.message}\n${stderr}`)) : resolve(stdout),
    ),
  );
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
const cases = ['1.16.5', '1.16.5-forge-36.2.34', 'neoforge-21.1.139'];
let instances;
if (!process.env.EASYCRAFT_SMOKE_DATA) {
  instances = JSON.parse(
    await readFile(path.join(preparation.data, 'instances.json'), 'utf8'),
  ).filter((v) => cases.includes(v.name));
  assert.equal(instances.length, 3);
  const files = new Set();
  const optional = new Set(['assets/log_configs/client-1.12.xml']);
  for (const instance of instances) {
    const profileFile = `instances/${instance.id}/local-profile.json`;
    const bytes = await readFile(path.join(preparation.data, profileFile));
    const profile = JSON.parse(bytes);
    const flags = profile.arguments.game;
    const flag = (name) => flags[flags.indexOf(name) + 1];
    const mc = flag('--fml.mcVersion');
    const neo = flag('--fml.neoForgeVersion');
    const forge = flag('--fml.forgeVersion');
    const coordinates =
      instance.local.loader === 'neoforge'
        ? [
            `net.neoforged:neoforge:${neo}:universal`,
            `net.neoforged:neoforge:${neo}:client`,
            `net.minecraft:client:${mc}-${flag('--fml.neoFormVersion')}:srg`,
            `net.minecraft:client:${mc}-${flag('--fml.neoFormVersion')}:extra`,
          ]
        : instance.local.loader === 'forge'
          ? [
              `${flag('--fml.forgeGroup')}:forge:${mc}-${forge}:universal`,
              `${flag('--fml.forgeGroup')}:forge:${mc}-${forge}:client`,
              `net.minecraft:client:${mc}-${flag('--fml.mcpVersion')}:srg`,
              `net.minecraft:client:${mc}-${flag('--fml.mcpVersion')}:extra`,
            ]
          : [];
    for (const coordinate of coordinates) {
      const [group, artifact, version, classifier] = coordinate.split(':');
      files.add(
        `libraries/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`,
      );
    }
    await mkdir(path.dirname(path.join(data, profileFile)), {
      recursive: true,
    });
    await writeFile(path.join(data, profileFile), bytes);
    files.add(instance.local.clientJar);
    for (const lib of profile.libraries) {
      if (lib.downloads?.artifact?.path)
        optional.add(`libraries/${lib.downloads.artifact.path}`);
      else if (!lib.downloads) {
        const [coordinate, ext = 'jar'] = lib.name.split('@');
        const [group, artifact, version, classifier] = coordinate.split(':');
        optional.add(
          `libraries/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`,
        );
      }
      for (const item of Object.values(lib.downloads?.classifiers || {}))
        optional.add(`libraries/${item.path}`);
    }
    const index = `assets/indexes/${profile.assetIndex.id}.json`;
    files.add(index);
    const assets = JSON.parse(
      await readFile(path.join(preparation.source, index), 'utf8'),
    );
    for (const object of Object.values(assets.objects)) {
      assert.match(object.hash, /^[a-f0-9]{40}$/);
      files.add(`assets/objects/${object.hash.slice(0, 2)}/${object.hash}`);
    }
    instance.local = {
      ...instance.local,
      root: sandbox,
      gameDirectory: `runs/${instance.name}`,
      versionDirectory: `runs/${instance.name}`,
    };
    instance.launch = {
      javaPath: path.join(
        project,
        '../build-tools/easycraft',
        instance.javaMajor === 8
          ? 'java8/jdk8u504-b01-jre/bin/java.exe'
          : 'java21/jdk-21.0.12.1+1-jre/bin/java.exe',
      ),
    };
    await mkdir(path.join(sandbox, instance.local.gameDirectory), {
      recursive: true,
    });
    await writeFile(
      path.join(sandbox, instance.local.gameDirectory, 'options.txt'),
      'music:0.0\nsoundCategory_master:0.0\nfullscreen:false\n',
    );
  }
  for (const file of optional) {
    try {
      if ((await lstat(path.join(preparation.source, file))).isFile())
        files.add(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const remaining = [...files];
  const snapshots = [];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (remaining.length) {
        const file = remaining.pop();
        assert(!file.includes('..') && !path.isAbsolute(file));
        const source = path.join(preparation.source, file),
          target = path.join(sandbox, file);
        assert(
          (await lstat(source)).isFile(),
          'No symlink or unrelated directory copied',
        );
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        const bytes = await readFile(target);
        snapshots.push({
          file,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }),
  );
  await writeFile(
    path.join(data, 'source-snapshot.json'),
    JSON.stringify(snapshots),
  );
  await writeFile(path.join(data, 'instances.json'), JSON.stringify(instances));
  await writeFile(
    path.join(data, 'settings.json'),
    JSON.stringify({
      clientId: '',
      javaPath: '',
      memoryMb: 2048,
      memoryMode: 'manual',
      optimizeMemory: false,
      launchMode: 'offline',
      offlineName: 'LaunchTest',
    }),
  );
  console.log(
    `Prepared ${files.size} genuine immutable files; original worlds, Mods and account configuration excluded. Data: ${data}`,
  );
} else
  instances = JSON.parse(
    await readFile(path.join(data, 'instances.json'), 'utf8'),
  );

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
const reports = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await delay(250);
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  await page.locator('.library-shell').waitFor();
  if (process.env.EASYCRAFT_EXPECT_WINDOWED) {
    await page.locator('.library-instance').first().click();
    await page.getByRole('tab', { name: '实例设置', exact: true }).click();
    const selector = page.getByRole('combobox', {
      name: '启动显示方式',
      exact: true,
    });
    for (const mode of ['fullscreen', 'inherit', 'windowed']) {
      await selector.selectOption(mode);
      await page
        .getByRole('button', { name: '保存启动窗口设置', exact: true })
        .click();
      for (let i = 0; i < 100; i++) {
        const s = await invoke('native_status');
        if ((s.instances[0].launch?.windowMode ?? 'windowed') === mode) break;
        await delay(50);
      }
      const saved = (await invoke('native_status')).instances[0];
      assert.equal(saved.launch?.windowMode ?? 'windowed', mode);
      assert.equal(saved.launch.javaPath, instances[0].launch.javaPath);
    }
    await page.screenshot({ path: path.join(output, 'window-settings.png') });
    if (process.env.EASYCRAFT_WINDOW_UI_ONLY) {
      await command('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(project, 'scripts/resize-native-test-window.ps1'),
        '-AppProcessId',
        String(child.pid),
        '-Width',
        '800',
        '-Height',
        '540',
      ]);
      await invoke('plugin:webview|set_webview_zoom', {
        label: 'main',
        value: 1.25,
      });
      await selector.scrollIntoViewIfNeeded();
      const bounds = await selector.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: innerWidth,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert(
        bounds.left >= 0 &&
          bounds.right <= bounds.width + 1 &&
          !bounds.overflow,
        JSON.stringify(bounds),
      );
      await selector.selectOption('inherit');
      await selector.press('Tab');
      assert(
        (await page.locator(':focus').textContent()).includes(
          '保存启动窗口设置',
        ),
      );
      await page
        .getByRole('button', { name: '放弃窗口修改', exact: true })
        .click();
      assert.equal(await selector.inputValue(), 'windowed');
      await page.screenshot({
        path: path.join(output, 'window-settings-minimum-125.png'),
      });
      await invoke('plugin:webview|set_webview_zoom', {
        label: 'main',
        value: 1,
      });
    }
  }
  for (const name of cases) {
    if (process.env.EASYCRAFT_WINDOW_UI_ONLY) break;
    if (
      process.env.EASYCRAFT_SMOKE_CASE &&
      name !== process.env.EASYCRAFT_SMOKE_CASE
    )
      continue;
    const instance = instances.find((v) => v.name === name);
    if (process.env.EASYCRAFT_SMOKE_FULLSCREEN) {
      const optionsFile = path.join(
        sandbox,
        instance.local.gameDirectory,
        'options.txt',
      );
      const original = await readFile(optionsFile, 'utf8');
      const value = process.env.EASYCRAFT_SMOKE_FULLSCREEN;
      assert(['true', 'false'].includes(value));
      await writeFile(
        optionsFile,
        original.replace(/^fullscreen:.*$/m, `fullscreen:${value}`),
      );
    }
    const control = path.join(data, `window-${randomUUID()}.pid`);
    let monitor;
    if (traceLabel) {
      monitor = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(project, 'scripts/watch-test-game-window.ps1'),
          '-LauncherProcessId',
          String(child.pid),
          '-Control',
          control,
          '-Output',
          path.join(output, `${name}-windows.json`),
        ],
        { windowsHide: true, stdio: 'inherit' },
      );
      for (let i = 0; i < 200; i++) {
        try {
          await readFile(control + '.ready');
          break;
        } catch {
          assert(monitor.exitCode === null, 'Window monitor failed');
          await delay(50);
        }
      }
    }
    const gameLogPath = path.join(
      sandbox,
      instance.local.gameDirectory,
      'logs/latest.log',
    );
    assert(path.resolve(gameLogPath).startsWith(sandbox + path.sep));
    await rm(gameLogPath, { force: true });
    const started = Date.now();
    await invoke('native_launch', { id: instance.id });
    let state,
      processStartedAt,
      renderedAt,
      stackTaken = false,
      gameLog = '';
    for (let attempt = 0; attempt < 180; attempt++) {
      state = await invoke('native_status');
      if (state.task.pid && !processStartedAt) {
        processStartedAt = Date.now();
        if (monitor) await writeFile(control, String(state.task.pid));
      }
      if (state.task.status === 'failed')
        throw Error(`${name}: ${JSON.stringify(state.task)}`);
      assert.notEqual(
        state.task.status,
        'succeeded',
        `${name} exited before menu capture`,
      );
      try {
        gameLog = await readFile(
          path.join(sandbox, instance.local.gameDirectory, 'logs/latest.log'),
          'utf8',
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (
        /Created:.*textures\/atlas\/(?:blocks|gui)/.test(gameLog) &&
        !renderedAt
      )
        renderedAt = Date.now();
      if (renderedAt && !stackTaken && process.env.EASYCRAFT_ATTACH_PROBE) {
        stackTaken = true;
        for (let probe = 0; probe < 3; probe++) {
          await writeFile(
            path.join(output, `${name}-threads-${probe}.txt`),
            await command(process.env.EASYCRAFT_ATTACH_PROBE, [
              String(state.task.pid),
              'threaddump',
            ]),
          );
          await delay(700);
        }
      }
      if (
        renderedAt &&
        Date.now() - renderedAt > settleWaitMs &&
        state.task.pid
      )
        break;
      await delay(500);
    }
    assert(renderedAt, `${name}: rendering was not initialized`);
    assert.equal(state.task.phase, 'game');
    await writeFile(path.join(output, `${name}.log`), gameLog);
    let capture;
    try {
      capture = JSON.parse(
        await command('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(project, 'scripts/capture-test-game.ps1'),
          '-GameProcessId',
          String(state.task.pid),
          '-LauncherProcessId',
          String(child.pid),
          '-JavaPath',
          instance.launch.javaPath,
          '-Sandbox',
          sandbox,
          '-GameDirectory',
          path.join(sandbox, instance.local.gameDirectory),
          '-Screenshot',
          path.join(project, 'output/playwright/launch-smoke', `${name}.png`),
        ]),
      );
    } catch (error) {
      if (
        !String(error).includes(
          'Owned test game is not foreground; no screen pixels captured.',
        )
      )
        throw error;
      capture = {
        skipped:
          'Test window was not foreground; earlier owned-window screenshots remain available.',
      };
    }
    reports.push({
      name,
      pid: state.task.pid,
      elapsedMs: Date.now() - started,
      processStartedMs: processStartedAt - started,
      renderingInitializedMs: renderedAt - started,
      settleWaitMs,
      capture,
      renderInitialized: true,
      mainMenuVisuallyVerified: false,
    });
    console.log(`CAPTURED ${name} after ${Date.now() - started} ms`);
    if (monitor) {
      await writeFile(control + '.stop', 'stop');
      await new Promise((resolve) => monitor.once('exit', resolve));
      assert.equal(monitor.exitCode, 0);
      const trace = JSON.parse(
        await readFile(path.join(output, `${name}-windows.json`), 'utf8'),
      );
      const visible = trace.events
        .flatMap((e) => e.windows)
        .filter((w) => w.Visible && !w.Title.includes('message'));
      assert(visible.length > 0, 'Must observe actual visible game windows');
      if (process.env.EASYCRAFT_EXPECT_WINDOWED) {
        assert(
          !visible.some((w) => w.Fullscreen),
          `${name} unexpectedly switched to fullscreen`,
        );
        assert.equal(
          new Set(visible.map((w) => w.Hwnd)).size,
          1,
          `${name} recreated its visible window`,
        );
        assert(
          !visible.some((w) => w.Minimized),
          `${name} unexpectedly minimized`,
        );
        if (name === '1.16.5-forge-36.2.34')
          assert(
            !visible.some((w) => w.Title === 'FML early loading progress'),
            'Legacy FML early window should not appear',
          );
        console.log(`PASS stable window: ${name}`);
      }
    }
    await invoke('native_cancel');
    for (let i = 0; i < 100; i++) {
      state = await invoke('native_status');
      if (!state.task.pid) break;
      await delay(100);
    }
    assert(!state.task.pid, 'Test game process must be reaped');
  }
  const snapshots = JSON.parse(
    await readFile(path.join(data, 'source-snapshot.json'), 'utf8'),
  );
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (snapshots.length) {
        const entry = snapshots.pop();
        assert.equal(
          createHash('sha256')
            .update(await readFile(path.join(preparation.source, entry.file)))
            .digest('hex'),
          entry.sha256,
          `Original changed: ${entry.file}`,
        );
      }
    }),
  );
  assert(!(await readdir(data)).some((v) => /account|auth|token/i.test(v)));
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        data,
        sandbox,
        source: preparation.source,
        sourceFilesUnchanged: true,
        reports,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        data,
        reports,
        error: String(error),
        task: page
          ? await invoke('native_status')
              .then((v) => v.task)
              .catch(() => null)
          : null,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (page) await invoke('native_cancel').catch(() => {});
  await delay(400);
  await browser?.close();
  if (child.exitCode === null) child.kill();
}
