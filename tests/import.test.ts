import { expect, test } from 'vitest';
import { previewFiles } from '../src/features/ImportPreview';
test('preview uses only metadata, handles extension casing and bounds file count', () => {
  expect(
    previewFiles([
      { name: 'a.ZIP', size: 42 },
      { name: 'b.mrpack', size: 99 },
      { name: 'bad.zip.exe', size: 1 },
    ]),
  ).toEqual([
    { name: 'a.ZIP', size: 42, type: 'ZIP' },
    { name: 'b.mrpack', size: 99, type: 'MRPACK' },
    { name: 'bad.zip.exe', size: 1, type: '不支持' },
  ]);
  expect(
    previewFiles(
      Array.from({ length: 30 }, () => ({ name: 'pack.zip', size: 100 })),
    ),
  ).toHaveLength(20);
});
