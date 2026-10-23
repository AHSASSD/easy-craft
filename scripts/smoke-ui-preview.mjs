import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output/playwright/ui-plan');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    pathToFileURL(path.join(root, 'docs/ui-preview/index.html')).href,
  );
  await mkdir(output, { recursive: true });
  const screenshot = (name) =>
    page.screenshot({
      path: path.join(output, name + '.png'),
      animations: 'disabled',
    });
  const button = (name) => page.getByRole('button', { name, exact: true });
  assert.equal(
    await page
      .getByRole('navigation', { name: '主入口' })
      .getByRole('button')
      .count(),
    3,
  );
  await screenshot('library');
  await button('设置').click();
  assert.equal(await page.locator('#left [data-category]').count(), 4);
  assert.equal(await page.locator('#left [data-game]').count(), 0);
  await page.getByRole('heading', { name: '启动设置', exact: true }).waitFor();
  await screenshot('settings');
  await button('个性化').click();
  await page
    .getByRole('heading', { name: '个性化设置', exact: true })
    .waitFor();
  await button('下载').click();
  assert.equal(await page.locator('#left [data-category]').count(), 6);
  await button('模组').click();
  await page.getByRole('heading', { name: '模组', exact: true }).waitFor();
  await screenshot('download');
  await button('数据包').click();
  await page.getByText('目标世界：山间的小屋（示例）').waitFor();
  await button('设置').click();
  await page
    .getByRole('heading', { name: '个性化设置', exact: true })
    .waitFor();
  await button('游戏库').click();
  await button('纯净原版 1.21.1 · 原版').click();
  await page.getByRole('heading', { name: '纯净原版', exact: true }).waitFor();
  await button('设置').click();
  await button('游戏库').click();
  await page.getByRole('heading', { name: '纯净原版', exact: true }).waitFor();
  await page.getByLabel('搜索示例实例').fill('纯净');
  assert.equal(await page.locator('[data-game]:visible').count(), 1);
  const divider = page.getByRole('separator');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await divider.getAttribute('aria-valuenow'), '290');
  await page.setViewportSize({ width: 800, height: 600 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await screenshot('minimum');
  await page.getByRole('button', { name: /EasyPlayer/ }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: '切换深浅色', exact: true }).click();
  assert(await page.locator('body.dark').count());
  await screenshot('dark');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: three entries, dynamic lists, remembered selections, world target, search, keyboard resize, 800px layout, dialog and themes.',
  );
} finally {
  await browser.close();
}
