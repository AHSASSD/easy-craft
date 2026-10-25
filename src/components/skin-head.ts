export function headPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (
    width !== 64 ||
    ![32, 64].includes(height) ||
    pixels.length !== width * height * 4
  )
    throw new Error('皮肤尺寸须为 64×64 或 64×32');
  let opaqueLegacyHat = height === 32;
  if (opaqueLegacyHat) {
    for (let y = 0; y < 32; y++)
      for (let x = 32; x < 64; x++)
        if (pixels[(y * 64 + x) * 4 + 3] < 128) opaqueLegacyHat = false;
  }
  const result = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const face = ((y + 8) * 64 + x + 8) * 4,
        hat = ((y + 8) * 64 + x + 40) * 4,
        output = (y * 8 + x) * 4;
      const alpha = opaqueLegacyHat ? 0 : pixels[hat + 3] / 255;
      for (let c = 0; c < 3; c++)
        result[output + c] = Math.round(
          pixels[face + c] * (1 - alpha) + pixels[hat + c] * alpha,
        );
      result[output + 3] = 255;
    }
  return result;
}
export async function skinHead(source: string): Promise<string> {
  const image = new Image();
  image.src = source;
  await image.decode();
  if (image.naturalWidth !== 64 || ![32, 64].includes(image.naturalHeight))
    throw new Error('皮肤尺寸不支持');
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制皮肤头像');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  const head = headPixels(
    context.getImageData(0, 0, 64, image.naturalHeight).data,
    64,
    image.naturalHeight,
  );
  canvas.width = canvas.height = 8;
  const output = context.createImageData(8, 8);
  output.data.set(head);
  context.putImageData(output, 0, 0);
  return canvas.toDataURL('image/png');
}
