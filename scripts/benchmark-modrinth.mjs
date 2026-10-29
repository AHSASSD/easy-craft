import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const label = process.argv[2] ?? 'sample';
assert(/^[a-z0-9-]+$/.test(label));
const output = path.join(project, 'output/playwright/modrinth-performance');
const data = path.join(project, '.native/modrinth-performance', randomUUID());
await mkdir(output, { recursive: true });
await mkdir(data, { recursive: true });
await writeFile(path.join(data, 'instances.json'), '[]');
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
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
let browser;
const samples = [];
const ui = [];
try {
  for (let i = 0; i < 50; i++) {
    assert(child.exitCode === null, 'Desktop exited');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  assert(browser, 'No desktop endpoint');
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.locator('.library-shell').waitFor();
  const invoke = (command, args) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  if (process.argv.includes('--cold-ui')) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '下载', exact: true })
      .click();
    await page
      .locator('.context-category-list')
      .getByRole('button', { name: '模组', exact: true })
      .click();
    const row = page.getByRole('button', {
      name: '查看 Fabric API',
      exact: true,
    });
    await row.waitFor({ timeout: 60000 });
    const started = performance.now();
    await row.click();
    await page
      .locator('.resource-version-list button')
      .first()
      .waitFor({ timeout: 60000 });
    const first = {
      name: 'cold-ui-first-versions',
      ms: Math.round(performance.now() - started),
      groups: await page.locator('.resource-game-group-toggle').count(),
      rows: await page.locator('.resource-version-list button').count(),
    };
    ui.push(first);
    console.log(JSON.stringify(first));
    await page.screenshot({ path: path.join(output, `${label}-first.png`) });
    await page.waitForFunction(
      () =>
        document
          .querySelector('.resource-detail')
          ?.getAttribute('data-catalog-pending') !== 'true',
      null,
      { timeout: 60000 },
    );
    const full = {
      name: 'cold-ui-full-catalog',
      ms: Math.round(performance.now() - started),
      groups: await page.locator('.resource-game-group-toggle').count(),
      rows: await page.locator('.resource-version-list button').count(),
    };
    assert(full.groups > 5, 'Full history did not finish loading');
    assert.equal(await page.locator('.resource-catalog-error').count(), 0);
    ui.push(full);
    console.log(JSON.stringify(full));
    await page
      .getByRole('button', { name: '返回搜索结果', exact: true })
      .click();
  }
  async function measure(name, command, args) {
    const started = performance.now();
    try {
      const value = await invoke(command, args);
      const sample = {
        name,
        ms: Math.round(performance.now() - started),
        rows: value.hits?.length ?? value.versions?.length ?? value.length,
        bytes: Buffer.byteLength(JSON.stringify(value)),
      };
      samples.push(sample);
      console.log(JSON.stringify(sample));
    } catch (error) {
      const sample = {
        name,
        ms: Math.round(performance.now() - started),
        error: String(error),
      };
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  for (let i = 0; i < 3; i++) {
    await measure(`search-${i}`, 'native_resource_search', {
      kind: 'mod',
      query: '',
      gameVersion: '1.21.1',
      offset: 0,
      category: '',
      index: 'downloads',
    });
    await measure(`categories-${i}`, 'native_resource_categories', {
      kind: 'mod',
    });
    await measure(`detail-all-${i}`, 'native_resource_detail', {
      project: 'P7dR8mSH',
      kind: 'mod',
      gameVersion: '1.21.1',
      allVersions: true,
    });
  }
  if (label !== 'baseline') {
    assert(
      samples.filter((s) => /-(1|2)$/.test(s.name)).every((s) => s.ms < 1000),
      'Warm metadata queries took over one second',
    );
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '下载', exact: true })
      .click();
    await page
      .locator('.context-category-list')
      .getByRole('button', { name: '模组', exact: true })
      .click();
    await page
      .locator('.resource-row-open')
      .first()
      .waitFor({ timeout: 60000 });
    const game = page.getByRole('combobox', {
      name: '在线资源游戏版本',
      exact: true,
    });
    if (!(await game.innerText()).includes('1.21.1')) {
      await game.click();
      await page
        .getByRole('searchbox', { name: '筛选在线资源游戏版本' })
        .fill('1.21.1');
      await page.getByRole('option', { name: '1.21.1', exact: true }).click();
      await page.getByRole('button', { name: '搜索资源', exact: true }).click();
    }
    const row = page.getByRole('button', {
      name: '查看 Fabric API',
      exact: true,
    });
    await row.waitFor({ timeout: 60000 });
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      await row.click();
      await page.locator('.resource-detail h2').waitFor({ timeout: 60000 });
      assert.equal(
        await page.locator('.resource-detail h2').innerText(),
        'Fabric API',
      );
      const firstMs = Math.round(performance.now() - started);
      await page.waitForFunction(
        () =>
          document
            .querySelector('.resource-detail')
            ?.getAttribute('data-catalog-pending') !== 'true',
        null,
        { timeout: 60000 },
      );
      assert(
        (await page.locator('.resource-game-group-toggle').count()) > 5,
        'Cross-Minecraft version groups were lost',
      );
      assert((await page.locator('.resource-version-list button').count()) > 0);
      const measurement = {
        name: `ui-open-${i}`,
        ms: firstMs,
        fullMs: Math.round(performance.now() - started),
      };
      ui.push(measurement);
      console.log(JSON.stringify(measurement));
      await page.screenshot({ path: path.join(output, `detail-${i}.png`) });
      await page
        .getByRole('button', { name: '返回搜索结果', exact: true })
        .click();
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.screenshot({ path: path.join(output, 'search.png') });
    await page
      .locator('.context-category-list')
      .getByRole('button', { name: '光影包', exact: true })
      .click();
    await page
      .locator('.resource-row-open')
      .first()
      .waitFor({ timeout: 60000 });
    await page
      .locator('.context-category-list')
      .getByRole('button', { name: '模组', exact: true })
      .click();
    await page
      .getByRole('button', { name: '查看 Fabric API', exact: true })
      .waitFor({ timeout: 60000 });
    const releaseFilter = page.getByRole('combobox', {
      name: '在线资源游戏版本',
      exact: true,
    });
    assert((await releaseFilter.innerText()).includes('1.21.1'));
    await releaseFilter.click();
    await page
      .getByRole('searchbox', { name: '筛选在线资源游戏版本' })
      .fill('1.21.1');
    assert.equal(
      await page.getByRole('option', { name: '1.21.1', exact: true }).count(),
      1,
    );
    await page.keyboard.press('Escape');
    ui.push({ name: 'release-filter-after-three-mounts', available: true });
  }
} finally {
  await writeFile(
    path.join(output, `${label}.json`),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        label,
        samples,
        ui,
      },
      null,
      2,
    ),
  );
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
assert(samples.length === 9 && samples.every((sample) => !sample.error));
