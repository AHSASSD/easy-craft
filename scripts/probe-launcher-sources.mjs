import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.native/source-probe',
);
await mkdir(root, { recursive: true });
const report = { forge: {}, curseforge: {} };
async function get(url, limit = 2 * 1024 * 1024) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'EasyCraft/0.3.1 source compatibility probe' },
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Response exceeds probe limit');
    chunks.push(chunk);
  }
  return { status: response.status, bytes: Buffer.concat(chunks) };
}
try {
  const metadata = await get(
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  );
  if (metadata.status !== 200)
    throw new Error(`Forge metadata HTTP ${metadata.status}`);
  const promos = JSON.parse(metadata.bytes.toString()).promos;
  const version = promos['1.21.1-recommended'] ?? promos['1.21.1-latest'];
  if (!/^\d+(\.\d+){1,3}$/.test(version))
    throw new Error('Invalid Forge promotion');
  const coordinate = `1.21.1-${version}`;
  const filename = `forge-${coordinate}-installer.jar`;
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/${filename}`;
  const checksum = await get(`${url}.sha1`);
  if (checksum.status !== 200)
    throw new Error(`Forge checksum HTTP ${checksum.status}`);
  const expected = checksum.bytes.toString().trim();
  if (!/^[0-9a-f]{40}$/i.test(expected))
    throw new Error('Invalid official Forge SHA-1');
  const installer = await get(url, 32 * 1024 * 1024);
  if (installer.status !== 200)
    throw new Error(`Forge installer HTTP ${installer.status}`);
  const actual = createHash('sha1').update(installer.bytes).digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase())
    throw new Error('Forge checksum mismatch');
  await writeFile(path.join(root, filename), installer.bytes);
  report.forge = {
    version,
    gameVersion: '1.21.1',
    url,
    filename,
    bytes: installer.bytes.length,
    sha1: actual,
    verified: true,
    installed: false,
  };
  console.log(
    `Forge: verified ${filename} (${installer.bytes.length} bytes); installer not executed.`,
  );
} catch (error) {
  report.forge = { error: error.message };
  console.log(`Forge: ${error.message}`);
}
for (const [name, url] of Object.entries({
  website: 'https://www.curseforge.com/minecraft/mc-mods',
  apiWithoutKey:
    'https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=sodium&pageSize=1',
})) {
  try {
    const result = await get(url, 8 * 1024 * 1024);
    report.curseforge[name] = {
      url,
      status: result.status,
      bytes: result.bytes.length,
    };
    console.log(`CurseForge ${name}: HTTP ${result.status}`);
  } catch (error) {
    report.curseforge[name] = { url, error: error.message };
    console.log(`CurseForge ${name}: ${error.message}`);
  }
}
await writeFile(
  path.join(root, 'report.json'),
  JSON.stringify(report, null, 2),
);
