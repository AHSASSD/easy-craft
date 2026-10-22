import { expect, test } from '@playwright/test';
test('instance operations, resize and theme survive refresh', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('演示模式', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索实例' }).fill('不存在');
  await expect(page.getByText('没有匹配的实例')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await page.getByRole('button', { name: /轻装出发 · Fabric 1.21.1/ }).click();
  await expect(page.locator('.summary-info h3')).toHaveText(
    '轻装出发 · Fabric',
  );
  await page
    .getByRole('button', { name: /轻装出发 · Fabric 1.21.1/ })
    .click({ button: 'right' });
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '实例名称' }).fill('我的 Fabric');
  await page.getByRole('button', { name: '保存演示资料' }).click();
  const divider = page.getByRole('separator');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '310');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await page.reload();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'grass');
  await expect(page.locator('.summary-info h3')).toHaveText('我的 Fabric');
  await expect(divider).toHaveAttribute('aria-valuenow', '310');
  expect(errors).toEqual([]);
});
test('minimum desktop size and keyboard dialog work', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 540 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /模拟启动/ })).toBeVisible();
  await page.getByRole('button', { name: /访客玩家/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '展开或折叠实例栏' }).click();
  await expect(page.getByRole('complementary')).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.screenshot({ path: 'output/playwright/home-dark.png' });
});
