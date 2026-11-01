import { expect, test } from '@playwright/test';
test('resource filters align as labeled fields and wrap without overflow', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await page.getByRole('button', { name: '模组', exact: true }).click();
  const controls = [
    '搜索在线资源',
    '在线资源游戏版本',
    '在线资源分类',
    '在线资源排序',
  ];
  for (const width of [1120, 800]) {
    await page.setViewportSize({ width, height: 720 });
    const boxes = await Promise.all(
      controls.map((name) =>
        page.getByLabel(name, { exact: true }).boundingBox(),
      ),
    );
    for (const box of boxes) {
      expect(box!.height).toBe(40);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    if (width === 1120) {
      expect(boxes[0]!.y).toBe(boxes[1]!.y);
      expect(boxes[2]!.y).toBe(boxes[3]!.y);
      const labels = await page
        .locator('.resource-search-form > label')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().y),
        );
      expect(labels[0]).toBe(labels[1]);
      expect(labels[2]).toBe(labels[3]);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole('combobox', { name: '在线资源排序', exact: true })
      .click();
    await expect(page.locator('.down-select-popup')).toBeVisible();
    const trigger = await page
      .getByLabel('在线资源排序', { exact: true })
      .boundingBox();
    const menu = await page.locator('.down-select-popup').boundingBox();
    expect(menu!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(720);
    await page.getByRole('option', { name: '最近更新', exact: true }).click();
    await expect(page.getByLabel('在线资源排序', { exact: true })).toHaveText(
      '最近更新',
    );
    await page.getByLabel('在线资源游戏版本', { exact: true }).click();
    await page
      .getByRole('searchbox', { name: '筛选在线资源游戏版本' })
      .fill('1.20.1');
    await page
      .getByRole('option', { name: '使用版本 1.20.1', exact: true })
      .click();
    await expect(
      page.getByLabel('在线资源游戏版本', { exact: true }),
    ).toHaveText('1.20.1');
  }
  await page.screenshot({
    path: 'output/playwright/resource-filters-minimum.png',
  });
  await expect(
    page.getByText('在线资源查询需要桌面版。', { exact: true }),
  ).toBeVisible();
});
test('real library is the default and remains usable at minimum size', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.library-instance')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '安装游戏', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tablist', { name: '实例工作区' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('img', { name: '默认玩家头像' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(4);
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
test('extensions remain honest in browser preview and keep accordion navigation', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '扩展', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '扩展工作区', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '我的工具', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.locator('.plugin-library-list .library-instance'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /官方工作区布局/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '实例扩展', exact: true }).click();
  await expect(
    page.locator('.extension-groups button[aria-expanded=true]'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('heading', { name: '扩展工作区', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '实例扩展', exact: true }).click();
  await expect(
    page.locator('.extension-groups button[aria-expanded=true]'),
  ).toHaveCount(0);
  await page.getByLabel('导入本地插件', { exact: true }).setInputFiles({
    name: 'test.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{}'),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: '本地插件安装需要桌面版' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '插件下载', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '插件目录尚未开放', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 540 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '界面外观', exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('appearance mask and reduced motion persist and honor the system preference', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  const preview = page.getByLabel('背景遮罩预览');
  const before = await preview.evaluate(
    (element) => element.style.backgroundImage,
  );
  await page.getByLabel('背景遮罩强度', { exact: true }).fill('65');
  await expect(preview).not.toHaveCSS('background-image', before);
  const motion = () =>
    page
      .getByRole('navigation')
      .getByRole('button')
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(await motion()).not.toBe('0s');
  await page.getByLabel('减少动态效果', { exact: true }).check();
  expect(await motion()).toBe('0s');
  await page.reload();
  await expect(page.getByLabel('背景遮罩强度', { exact: true })).toHaveValue(
    '65',
  );
  await expect(page.getByLabel('减少动态效果', { exact: true })).toBeChecked();
  const saved = await preview.evaluate(
    (element) => getComputedStyle(element).backgroundImage,
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '游戏库', exact: true })
    .click();
  await expect(page.locator('.library-welcome')).toHaveCSS(
    'background-image',
    saved,
  );
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByLabel('减少动态效果', { exact: true }).uncheck();
  expect(await motion()).not.toBe('0s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await motion()).toBe('0s');
  await page.setViewportSize({ width: 800, height: 540 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByLabel('背景遮罩强度', { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.getByLabel('背景遮罩强度', { exact: true })).toBeVisible();
  await page.screenshot({
    path: 'output/playwright/appearance-mask-minimum.png',
  });
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'easycraft.preferences.v1')
        throw new DOMException('Fixture storage full', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.getByLabel('背景遮罩强度', { exact: true }).fill('70');
  await expect(page.getByRole('alert')).toContainText(
    '本次更改仅在当前窗口有效',
  );
  await page.reload();
  await expect(page.getByLabel('背景遮罩强度', { exact: true })).toHaveValue(
    '65',
  );
});

test('rail labels, selected categories and secondary text meet contrast targets in both themes', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  for (const name of ['草方块亮色', '深板岩夜色']) {
    await page.getByRole('button', { name: new RegExp(name) }).click();
    for (const color of [
      undefined,
      '#1488ee',
      '#ffffff',
      '#000000',
      '#ffff00',
    ]) {
      if (color)
        await page.getByLabel('自定义强调色', { exact: true }).fill(color);
      else if (
        await page
          .getByRole('button', { name: '恢复默认强调色', exact: true })
          .isEnabled()
      )
        await page
          .getByRole('button', { name: '恢复默认强调色', exact: true })
          .click();
      await page.locator('.native-library').evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      const results = await page.evaluate(() => {
        const style = (selector: string) =>
          getComputedStyle(document.querySelector(selector)!);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const luminance = (color: string) => {
          if (!CSS.supports('color', color.trim()))
            throw new Error(`Invalid measured color: ${color}`);
          context.fillStyle = color.trim();
          context.fillRect(0, 0, 1, 1);
          const values = Array.from(
            context.getImageData(0, 0, 1, 1).data,
          ).slice(0, 3);
          const components = values.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return (
            components[0] * 0.2126 +
            components[1] * 0.7152 +
            components[2] * 0.0722
          );
        };
        const contrast = (a: string, b: string) => {
          const first = luminance(a),
            second = luminance(b);
          return (
            (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
          );
        };
        const active = style('.global-rail .active');
        const category = style('.context-category-list .selected');
        const breadcrumb = style('.workspace-breadcrumb');
        const navigation = style('.global-rail');
        const inactive = style('.global-rail button:not(.active)');
        const root = style('.native-library');
        return [
          ...['--bg', '--surface', '--panel', '--hover', '--accent-dark'].map(
            (name) =>
              contrast(
                root.getPropertyValue('--accent'),
                root.getPropertyValue(name),
              ),
          ),
          contrast(active.color, active.backgroundColor),
          contrast(category.color, category.backgroundColor),
          contrast(breadcrumb.color, breadcrumb.backgroundColor),
          contrast(inactive.color, navigation.backgroundColor),
        ];
      });
      for (const [index, ratio] of results.entries())
        expect(
          ratio,
          `${name} ${color ?? 'default'}, color pair ${index}: ${results.join(', ')}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('custom accent previews, persists across themes and reset removes all inline overrides', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  const root = page.locator('.native-library');
  const gradient = await page
    .locator('.global-rail .active')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect(
    page.getByRole('button', { name: '恢复默认强调色', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('自定义强调色', { exact: true }).fill('#1488ee');
  await expect(root).toHaveAttribute('data-custom-accent', 'true');
  await expect(page.locator('.global-rail .active')).not.toHaveCSS(
    'background-color',
    gradient,
  );
  const light = await root.evaluate((element) =>
    element.style.getPropertyValue('--accent'),
  );
  await page.reload();
  await expect(page.getByLabel('自定义强调色', { exact: true })).toHaveValue(
    '#1488ee',
  );
  await page.screenshot({ path: 'output/playwright/accent-light.png' });
  await page.getByRole('button', { name: /深板岩夜色/ }).click();
  expect(
    await root.evaluate((element) =>
      element.style.getPropertyValue('--accent'),
    ),
  ).not.toBe(light);
  await expect(page.getByLabel('自定义强调色', { exact: true })).toHaveValue(
    '#1488ee',
  );
  await page
    .getByRole('button', { name: '恢复默认强调色', exact: true })
    .click();
  await expect(root).not.toHaveAttribute('data-custom-accent');
  expect(
    await root.evaluate((element) =>
      element.style.getPropertyValue('--accent'),
    ),
  ).toBe('');
  expect(
    await root.evaluate((element) =>
      element.style.getPropertyValue('--action'),
    ),
  ).toBe('');
  expect(
    await page.evaluate(() =>
      Object.hasOwn(
        JSON.parse(localStorage.getItem('easycraft.preferences.v1')!),
        'accentColor',
      ),
    ),
  ).toBe(false);
  await page.reload();
  await expect(
    page.getByRole('button', { name: '恢复默认强调色', exact: true }),
  ).toBeDisabled();
  await expect(root).toHaveAttribute('data-theme', 'slate');
});

test('compact context overlay keeps navigation, categories, account and focus usable without changing saved width', async ({
  page,
}) => {
  await page.goto('/');
  const divider = page.getByRole('separator', { name: '调整实例栏宽度' });
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  const savedWidth = await divider.getAttribute('aria-valuenow');
  for (const viewport of [
    { width: 640, height: 432 },
    { width: 533, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.library-shell')).toHaveClass(/compact-context/);
    await expect(page.getByLabel('实例与分类栏', { exact: true })).toBeHidden();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.locator('.context-category-list button')).toHaveCount(4);
    await expect(
      page.getByLabel('实例与分类栏', { exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator('.library-main')
        .evaluate((element) => element.hasAttribute('inert')),
    ).toBe(true);
    await page.getByRole('button', { name: '个性化', exact: true }).click();
    await expect(page.getByLabel('实例与分类栏', { exact: true })).toBeHidden();
    await expect(page.getByLabel('界面缩放', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('heading', { name: '个性化设置', exact: true }),
    ).toBeVisible();
    expect(
      (await page.locator('.library-main').boundingBox())!.width,
    ).toBeGreaterThan(viewport.width - 80);
    await page
      .getByRole('button', { name: '展开或折叠实例栏', exact: true })
      .click();
    await page
      .getByRole('button', { name: '管理游戏账户', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByLabel('实例与分类栏', { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('实例与分类栏', { exact: true })).toBeHidden();
    await expect(
      page.getByRole('button', { name: '展开或折叠实例栏', exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole('button', { name: '管理游戏账户', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '下载', exact: true })
      .click();
    await expect(page.locator('.context-category-list button')).toHaveCount(6);
    await page.getByRole('button', { name: '数据包', exact: true }).click();
    await expect(page.getByLabel('实例与分类栏', { exact: true })).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    for (const label of ['游戏库', '设置', '下载'])
      await expect(
        page
          .getByRole('navigation')
          .getByRole('button', { name: label, exact: true }),
      ).toBeVisible();
  }
  await page.screenshot({ path: 'output/playwright/compact-context.png' });
  await page.setViewportSize({ width: 1120, height: 720 });
  await expect(page.getByLabel('实例与分类栏', { exact: true })).toBeVisible();
  await expect(divider).toHaveAttribute('aria-valuenow', savedWidth!);
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
  await expect(page).toHaveURL(/\/\?demo=1$/);
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
  const resizedWidth = String(
    Number(await divider.getAttribute('aria-valuenow')) + 10,
  );
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', resizedWidth);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await page.reload();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'grass');
  await expect(page.locator('.summary-info h3')).toHaveText('我的 Fabric');
  await expect(divider).toHaveAttribute('aria-valuenow', resizedWidth);
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
