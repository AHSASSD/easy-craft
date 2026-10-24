export async function backgroundImage(file: File): Promise<Blob> {
  if (
    file.size > 10 * 1024 * 1024 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
  )
    throw new Error('请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 图片');
  const url = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 16 * 1024 * 1024
    )
      throw new Error('背景尺寸须在 1600 万像素以内');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前环境无法处理背景图片');
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('背景转换失败'))),
        'image/png',
      ),
    );
    if (png.size > 10 * 1024 * 1024)
      throw new Error('转换后的背景超过 10 MiB，请缩小图片后重试');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}
