import 'server-only';
import sharp from 'sharp';
import { AppError } from '../errors';
import type { StyleReferenceImage } from '../personal/style-learning';

export async function cleanStyleReferenceImage(bytes: Buffer): Promise<string> {
  try {
    const image = sharp(bytes, { limitInputPixels: 24_000_000, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages ?? 1) > 1) throw new Error('invalid image');
    const clean = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    return `data:image/jpeg;base64,${clean.toString('base64')}`;
  } catch { throw new AppError('INVALID_IMAGE', '参考图无法读取，请使用完整的 JPEG、PNG 或 WebP 图片。', 400); }
}

export async function prepareStyleReferenceImages(images: StyleReferenceImage[], signal: AbortSignal) {
  const clean: StyleReferenceImage[] = [];
  for (const image of images) {
    signal.throwIfAborted();
    clean.push({ ...image, dataUrl: await cleanStyleReferenceImage(Buffer.from(image.dataUrl.split(',')[1], 'base64')) });
  }
  signal.throwIfAborted();
  return clean;
}
