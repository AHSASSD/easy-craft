import { expect, test } from 'vitest';
import { headPixels } from '../src/components/skin-head';

function pixel(data: Uint8ClampedArray, x: number, y: number, rgba: number[]) {
  data.set(rgba, (y * 64 + x) * 4);
}
test('head uses the real face pixels and alpha-composites the head overlay', () => {
  const skin = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 8; y < 16; y++)
    for (let x = 8; x < 16; x++) pixel(skin, x, y, [180, 120, 60, 255]);
  pixel(skin, 40, 8, [10, 20, 30, 255]);
  pixel(skin, 41, 8, [0, 0, 200, 128]);
  pixel(skin, 0, 0, [255, 0, 255, 255]);
  const head = headPixels(skin, 64, 64);
  expect(Array.from(head.slice(0, 4))).toEqual([10, 20, 30, 255]);
  expect(Array.from(head.slice(4, 8))).toEqual([90, 60, 130, 255]);
  expect(Array.from(head.slice(8, 12))).toEqual([180, 120, 60, 255]);
  expect(Array.from(head.slice(-4))).toEqual([180, 120, 60, 255]);
  expect(head).toHaveLength(8 * 8 * 4);
});
test('legacy opaque overlay does not cover the face and skin dimensions are bounded', () => {
  const skin = new Uint8ClampedArray(64 * 32 * 4).fill(255);
  pixel(skin, 8, 8, [30, 60, 90, 255]);
  expect(Array.from(headPixels(skin, 64, 32).slice(0, 4))).toEqual([
    30, 60, 90, 255,
  ]);
  pixel(skin, 32, 0, [0, 0, 0, 0]);
  expect(Array.from(headPixels(skin, 64, 32).slice(0, 4))).toEqual([
    255, 255, 255, 255,
  ]);
  for (const dimensions of [
    [128, 64],
    [64, 16],
    [32, 32],
  ])
    expect(() => headPixels(skin, dimensions[0], dimensions[1])).toThrow(
      '皮肤尺寸',
    );
  expect(() => headPixels(new Uint8ClampedArray(1), 64, 64)).toThrow(
    '皮肤尺寸',
  );
});
