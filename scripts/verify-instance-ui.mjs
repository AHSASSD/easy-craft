// Desktop-only UI fixtures. No personal instances, Minecraft launch, login or downloads.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, readdir, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const data = path.join(project, '.native/instance-ui', randomUUID());
const output = path.join(project, 'output/playwright/instance-ui');
const game = path.join(data, 'instances/ui-review/game');
const command = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) =>
        error ? reject(Error(`${error.message}\n${stderr}`)) : resolve(stdout),
    ),
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
for (const dir of [
  'mods',
  'resourcepacks',
  'shaderpacks',
  'screenshots',
  'saves',
])
  await mkdir(path.join(game, dir), { recursive: true });
await writeFile(
  path.join(data, 'instances.json'),
  JSON.stringify([
    {
      id: 'ui-review',
      name: '山谷漫游 · UI 验收样例',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '0.16.14',
      fabricSha1: 'b'.repeat(40),
    },
    {
      id: 'ui-empty',
      name: '空实例 · UI 验收样例',
      version: '1.21.1',
      manifestSha1: 'a'.repeat(40),
      javaMajor: 21,
      fabricVersion: '',
      fabricSha1: '',
    },
  ]),
);
await mkdir(path.join(data, 'instances/ui-empty/game'), { recursive: true });
await writeFile(
  path.join(data, 'settings.json'),
  JSON.stringify({
    clientId: '',
    javaPath: path.join(
      project,
      '../build-tools/easycraft/java21/jdk-21.0.12.1+1-jre/bin/java.exe',
    ),
    memoryMode: 'auto',
    memoryMb: 2048,
    optimizeMemory: false,
    launchMode: 'offline',
    offlineName: 'UIReview',
  }),
);
await writeFile(
  path.join(game, 'options.txt'),
  'version:3955\ncustomMod:keep-this-field\nsoundCategory_master:0.7\nsoundCategory_music:0.4\nrenderDistance:12\nfullscreen:false\n',
);
for (const world of [
  '松林小屋 · UI 样例',
  '红石实验室 · UI 样例',
  '长名称世界 · 山谷中的探险与建筑计划',
]) {
  await mkdir(path.join(game, 'saves', world), { recursive: true });
  await copyFile(
    path.join(project, '.native/fixtures/world/level.dat'),
    path.join(game, 'saves', world, 'level.dat'),
  );
}
const fixtures = `import zipfile,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
names=['地图工具','光照优化','建筑辅助','界面与字体','背包整理','声音增强','按键管理','方块渲染','世界地图','性能配置','自定义菜单','这是一段用于验证截断的超长模组名称和附加说明' * 3]
for i,name in enumerate(names):
  suffix='.jar.disabled' if i%4==0 else '.jar'
  with zipfile.ZipFile(root/'mods'/('ui-review-'+str(i)+suffix),'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('fabric.mod.json',json.dumps({'schemaVersion':1,'id':'ui_review_'+str(i),'name':name+' · UI 样例','version':'1.0.'+str(i)},ensure_ascii=False))
(root/'mods'/'unknown-file.jar').write_bytes(b'Unknown inert UI fixture; preserve read-only')
for i in range(4):
  with zipfile.ZipFile(root/'resourcepacks'/('UI-Resource-Pack-'+str(i)+'.zip'),'w',zipfile.ZIP_DEFLATED) as z:z.writestr('pack.mcmeta',json.dumps({'pack':{'pack_format':34,'description':'UI fixture'}}))
for i in range(3):
  with zipfile.ZipFile(root/'shaderpacks'/('UI-Shader-Pack-'+str(i)+'.zip'),'w',zipfile.ZIP_DEFLATED) as z:z.writestr('shaders/README.txt','Inert UI fixture')
`;
await command('python', ['-c', fixtures, game]);
const sources = [
  '1.16.5.png',
  '1.16.5-forge-36.2.34.png',
  'neoforge-21.1.139.png',
];
for (let i = 0; i < 6; i++)
  await copyFile(
    path.join(project, 'output/playwright/launch-smoke', sources[i % 3]),
    path.join(game, 'screenshots', `UI-review-${i + 1}-${sources[i % 3]}`),
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
const errors = [],
  checks = [];
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const shot = (name) =>
  page.screenshot({
    path: path.join(output, name + '.png'),
    animations: 'disabled',
  });
async function tab(name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await pause(250);
}
async function resize(width, height) {
  await command('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(project, 'scripts/resize-native-test-window.ps1'),
    '-AppProcessId',
    String(child.pid),
    '-Width',
    String(width),
    '-Height',
    String(height),
  ]);
}
async function bounds() {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    contentOverflow: [...document.querySelectorAll('.instance-manager')].some(
      (e) => e.scrollWidth > e.clientWidth + 2,
    ),
  }));
  assert(!result.overflow && !result.contentOverflow, JSON.stringify(result));
  return result;
}
try {
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await pause(250);
    }
  }
  assert(browser);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.library-shell').waitFor();
  await resize(1120, 720);
  await page
    .locator('.library-instance')
    .filter({ hasText: '山谷漫游' })
    .click();
  await tab('模组');
  await page.locator('.content-file-row').nth(12).waitFor();
  checks.push({
    check:
      'Thirteen genuine local entries from inert fixtures, compact rows and long metadata names',
    rows: await page.locator('.content-file-row').count(),
    bounds: await bounds(),
  });
  await shot('01-mods-dark');
  await page
    .getByRole('combobox', { name: '筛选模组状态' })
    .selectOption('readonly');
  assert.equal(await page.locator('.content-file-row').count(), 1);
  await page
    .getByRole('combobox', { name: '筛选模组状态' })
    .selectOption('enabled');
  assert.equal(await page.locator('.content-file-row').count(), 9);
  await page.getByLabel('确认内容修改前游戏已关闭').check();
  await page.locator('.content-file-row input[type=checkbox]').first().click();
  for (let i = 0; i < 100; i++) {
    if (
      (await readdir(path.join(game, 'mods'))).filter((v) =>
        v.endsWith('.disabled'),
      ).length === 4
    )
      break;
    await pause(50);
  }
  assert.equal(
    (await readdir(path.join(game, 'mods'))).filter((v) =>
      v.endsWith('.disabled'),
    ).length,
    4,
  );
  await page
    .getByRole('combobox', { name: '筛选模组状态' })
    .selectOption('all');
  await page.getByLabel('搜索本地模组').fill('no-matching-file');
  await page.getByRole('heading', { name: '没有匹配的内容' }).waitFor();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  checks.push({
    check: 'Mod filters, empty search and guarded real file toggle passed',
  });
  await tab('资源与光影');
  await page.locator('.content-file-row').nth(3).waitFor();
  await shot('02-resources-dark');
  await page.getByRole('button', { name: '光影包', exact: true }).click();
  await page.locator('.content-file-row').nth(2).waitFor();
  assert.equal(await page.locator('.content-file-row').count(), 3);
  await shot('03-shaders-dark');
  await tab('截图');
  await page.locator('.screenshot-card').nth(5).waitFor();
  await page.locator('.screenshot-thumbnail img').first().waitFor();
  await shot('04-screenshots-dark');
  await page.locator('.screenshot-open').first().click();
  await page.locator('.screenshot-preview').waitFor();
  await shot('05-screenshot-preview');
  await page.keyboard.press('Escape');
  checks.push({
    check:
      'Resource/shader switching, six lazy screenshot thumbnails and actual image preview passed',
  });
  await tab('存档');
  await page.getByLabel('世界难度').waitFor();
  assert.equal(await page.locator('.world-choice-list button').count(), 3);
  await shot('06-worlds-dark');
  await page
    .getByLabel('世界难度')
    .selectOption(
      (await page.getByLabel('世界难度').inputValue()) === '3' ? '2' : '3',
    );
  await page.locator('.world-choice-list button').nth(1).click();
  await page
    .getByRole('dialog', { name: '有尚未保存的修改', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await page.locator('.world-choice-list button').nth(1).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await page.getByLabel('世界难度').waitFor();
  await page.locator('.world-rules-details > summary').click();
  await page.getByLabel('搜索游戏规则').fill('keepInventory');
  await shot('07-world-rules');
  await page.getByLabel('搜索游戏规则').fill('');
  checks.push({
    check:
      'World master/detail selection, unsaved changes guard and advanced rule search passed',
  });
  await tab('实例设置');
  await page.getByRole('combobox', { name: '启动显示方式' }).waitFor();
  await shot('08-settings-display');
  await page.getByRole('button', { name: /运行环境/ }).click();
  await page.getByLabel('Java 可执行文件').waitFor();
  await shot('09-settings-runtime');
  await page.getByRole('button', { name: /目录与隔离/ }).click();
  await page.getByLabel('此版本隔离').waitFor();
  await shot('10-settings-directory');
  await page.getByRole('button', { name: /显示与音画/ }).click();
  await page
    .getByRole('combobox', { name: '启动显示方式' })
    .selectOption('fullscreen');
  await page.getByRole('button', { name: /运行环境/ }).click();
  await page
    .getByRole('dialog', { name: '有尚未保存的修改', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  assert.equal(await page.getByLabel('Java 可执行文件').count(), 1);
  checks.push({
    check:
      'Three settings groups, retained launch configuration and unsaved navigation guard passed',
  });
  await resize(800, 540);
  await invoke('plugin:webview|set_webview_zoom', {
    label: 'main',
    value: 1.25,
  });
  for (const label of ['模组', '资源与光影', '存档', '截图', '实例设置']) {
    await tab(label);
    await bounds();
    await shot('minimum-' + label);
  }
  checks.push({
    check:
      'All five workspaces fit minimum 800x540 window at 125% without horizontal overflow',
  });
  await invoke('plugin:webview|set_webview_zoom', { label: 'main', value: 1 });
  await resize(1120, 720);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '个性化', exact: true }).click();
  await page.getByRole('button', { name: /草方块亮色/ }).click();
  await page.getByRole('button', { name: '游戏库', exact: true }).click();
  for (const label of ['模组', '资源与光影', '存档', '截图', '实例设置']) {
    await tab(label);
    await bounds();
    await shot('light-' + label);
  }
  await page.locator('.library-instance').filter({ hasText: '空实例' }).click();
  for (const label of ['模组', '资源与光影', '存档', '截图', '实例设置']) {
    await tab(label);
    await bounds();
    await shot('empty-' + label);
  }
  checks.push({
    check: 'Light theme and empty local directories use real zero-data states',
  });
  const status = await invoke('native_status');
  assert.equal(status.task.pid, null);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        data,
        fixtures:
          'Synthetic inert Mod/resource/world metadata and genuine earlier Minecraft PNGs. No Minecraft launched.',
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(checks, null, 2));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill();
}
