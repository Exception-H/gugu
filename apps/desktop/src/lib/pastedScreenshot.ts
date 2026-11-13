export const SCREENSHOT_MAX_EDGE = 2000;
export const SCREENSHOT_TARGET_BYTES = 300 * 1024;
export type ScreenshotQuality = 'compressed' | 'original';
type Screenshot = { quality: ScreenshotQuality; compressed?: Promise<File>; failed?: boolean };
const screenshots = new WeakMap<File, Screenshot>();
const previews = new WeakMap<File, string>();

export function screenshotPreview(file: File): Promise<string> {
  let preview = previews.get(file);
  if (!preview) {
    // 预览只给 <img> 看,交给浏览器惰性解码。
    // ❌ 别逐字节拼字符串再 btoa:2000px 的原图会在主线程上占住几百毫秒,粘贴时输入框直接顿住。
    preview = URL.createObjectURL(file);
    previews.set(file, preview);
  }
  return Promise.resolve(preview);
}

/** 这枚文件不要了:把预览 URL 收回去 —— 不收的话那张图的字节会一直挂在渲染进程里。 */
export function releaseScreenshotPreview(file: File): void {
  const preview = previews.get(file);
  if (!preview) return;
  previews.delete(file);
  URL.revokeObjectURL(preview);
}

/** Only clipboard PNG/JPEG screenshots opt in; picked files and animated images keep their bytes. */
export function registerPastedScreenshot(file: File): void {
  if (/^image\/(png|jpeg)$/i.test(file.type) && !screenshots.has(file)) screenshots.set(file, { quality: 'compressed' });
}
export const screenshotQuality = (file: File): ScreenshotQuality | undefined => screenshots.get(file)?.quality;
export function toggleScreenshotQuality(file: File): void {
  const image = screenshots.get(file);
  if (image) image.quality = image.quality === 'compressed' ? 'original' : 'compressed';
}
export function retryScreenshot(file: File): void {
  const image = screenshots.get(file);
  if (image?.failed) { image.compressed = undefined; image.failed = false; }
}

/** Kept on the source File so draft hand-off and ordinary retries reuse the exact encoded bytes. */
export function selectedScreenshot(file: File): Promise<File> {
  const image = screenshots.get(file);
  if (!image || image.quality === 'original') return Promise.resolve(file);
  return image.compressed ??= compressScreenshot(file).catch(error => {
    image.failed = true;
    throw Object.assign(new Error('Screenshot conversion failed', { cause: error }), { code: 'screenshot_processing_failed' });
  });
}

export async function compressScreenshot(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('Empty screenshot');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable');
    const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    let encoded: Blob | null = null;
    for (const quality of [0.85, 0.78, 0.72]) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
        if (blob?.type === 'image/webp') resolve(blob);
        else reject(new Error('WebP encoding is unavailable'));
      }, 'image/webp', quality));
      if (encoded.size <= SCREENSHOT_TARGET_BYTES) break;
    }
    if (!encoded) throw new Error('Screenshot conversion produced no image');
    // A small original is preferable to a larger WebP, but oversized originals still need resizing.
    if (Math.max(bitmap.width, bitmap.height) <= SCREENSHOT_MAX_EDGE && file.size <= encoded.size) return file;
    return new File([encoded], `${(file.name || 'screenshot').replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp', lastModified: file.lastModified });
  } finally { bitmap.close(); }
}
