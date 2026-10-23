import { expect, test } from '@playwright/test';
test('real library is the default and remains usable at minimum size', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.library-instance')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '启动游戏', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('img', { name: '默认玩家头像' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(3);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.locator('.context-category-list button')).toHaveCount(4);
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await page.screenshot({ path: 'output/playwright/library-light.png' });
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await expect(page.locator('.context-category-list button')).toHaveCount(6);
  await page.getByRole('button', { name: '模组', exact: true }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '个性化设置' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '个性化设置' })).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 540 });
  expect(
    (await page.locator('.library-main').boundingBox())!.width,
  ).toBeGreaterThan(450);
  await page
    .getByRole('button', { name: '展开或折叠实例栏', exact: true })
    .click();
  expect(
    (await page.locator('.library-main').boundingBox())!.width,
  ).toBeGreaterThan(700);
  await expect(
    page
      .getByRole('navigation')
      .getByRole('button', { name: '设置', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '展开或折叠实例栏', exact: true })
    .click();
  expect(
    (await page.locator('.library-main').boundingBox())!.width,
  ).toBeGreaterThan(450);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '管理游戏账户' }).click();
  await expect(
    page.getByRole('button', { name: '离线登录', exact: true }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('real features are explicitly unavailable in browser and never simulated', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载中心', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '原版下载与启动' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      '浏览器仅提供演示。请运行桌面版使用正版登录、资源下载和游戏启动；此页面不会在浏览器中模拟这些能力。',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '下载并安装原版' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '管理游戏账户' }).click();
  await expect(
    page.getByRole('button', { name: '正版登录', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '离线登录', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await page.screenshot({
    path: 'output/playwright/native-browser-boundary.png',
  });
});
test('add, copy, favorite, double click opt-in and developer diagnostics work', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '添加演示实例' }).click();
  await page.getByRole('textbox', { name: '实例名称' }).fill('我的演示世界');
  await page.getByRole('button', { name: '保存演示资料' }).click();
  await page.getByRole('textbox', { name: '搜索实例' }).fill('我的演示世界');
  await page.getByRole('button', { name: /我的演示世界 1.21.1/ }).dblclick();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page
    .getByRole('button', { name: '收藏 我的演示世界', exact: true })
    .click();
  await page.getByRole('combobox', { name: '实例排序' }).selectOption('name');
  await page.getByRole('button', { name: '我的演示世界 操作' }).click();
  await page.getByRole('button', { name: '复制实例（模拟）' }).click();
  await expect(page.locator('.instance-row')).toHaveCount(2);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('checkbox', { name: /双击实例模拟启动/ }).check();
  await page.getByRole('checkbox', { name: /启用开发者工具/ }).check();
  await page.getByRole('button', { name: '开发者工具', exact: true }).click();
  await expect(page.locator('.diagnostics')).toContainText(
    'official.demo-launch',
  );
  await page.getByRole('button', { name: /我的演示世界 1.21.1/ }).dblclick();
  await expect(
    page.getByRole('heading', { name: '模拟启动进行中' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消模拟启动' }).click();
  await expect(
    page.getByRole('heading', { name: '模拟启动已取消' }),
  ).toBeVisible();
});
test('light theme and local background preview work', async ({ page }) => {
  await page.goto('/?demo=1');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await page.getByLabel('选择背景图片').setInputFiles({
    name: 'local.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLl8AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await expect(page.locator('.hero')).toHaveClass(/custom-background/);
  await expect(page.locator('.hero')).toHaveAttribute('style', /blob:/);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '恢复地形背景' }).click();
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/home-light.png' });
});
test('simulation survives navigation, cancels, retries, and completes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '模拟启动 DEMO' }).click();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '模拟启动进行中' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消模拟启动' }).click();
  await expect(
    page.getByRole('heading', { name: '模拟启动已取消' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重试模拟启动' }).click();
  await expect(page.getByRole('heading', { name: '模拟启动完成' })).toBeVisible(
    { timeout: 10000 },
  );
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  await page.getByText('查看演示日志（8）').click();
  await expect(
    page.getByText('启动完成（模拟，未创建游戏进程）').last(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('failure demo and file drop preview do not navigate away', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: /山间工坊 1.20.1/ }).click();
  await page.getByRole('button', { name: '模拟启动 DEMO' }).click();
  await expect(
    page.getByRole('heading', { name: '模拟启动失败' }),
  ).toBeVisible();
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(['demo'], '冒险.mrpack', { type: 'application/zip' }),
    );
    return transfer;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer: data });
  await data.dispose();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('冒险.mrpack')).toBeVisible();
  await expect(dialog.getByText('MRPACK · 4 字节')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL('http://127.0.0.1:1420/?demo=1');
});
test('instance operations, resize and theme survive refresh', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1');
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
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: /模拟启动/ })).toBeVisible();
  await page.getByRole('button', { name: '管理游戏账户' }).click();
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
