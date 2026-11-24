import { IMAGE_TYPES, MAX_EDGE, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "./constants";
import type { StudioImage } from "./types";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("这张图片无法读取，请换一张完整的图片。"));
    image.src = src;
  });
}
export async function prepareImage(file: File): Promise<StudioImage> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`“${file.name}”格式不支持，请使用 JPEG、PNG 或 WebP。`);
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}”须非空且不超过 5MB。`);
  const preview = URL.createObjectURL(file);
  try {
    const image = await loadImage(preview);
    if (image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error(`“${file.name}”像素过多，请缩小到 2400 万像素以内。`);
    return { id: crypto.randomUUID(), file, preview, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) { URL.revokeObjectURL(preview); throw error; }
}

async function compressOne(image: StudioImage, edge: number, quality: number): Promise<Blob> {
  const original = await loadImage(image.preview);
  const scale = Math.min(1, edge / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法处理图片，请更换浏览器重试。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(original, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败，请重试。")), "image/jpeg", quality));
}
export async function compressImages(images: StudioImage[], onProgress: (done: number, total: number) => void): Promise<Blob[]> {
  const attempts = [[MAX_EDGE, 0.86], [MAX_EDGE, 0.7], [1280, 0.65], [960, 0.55]];
  for (const [edge, quality] of attempts) {
    const blobs: Blob[] = [];
    for (const [index, image] of images.entries()) {
      blobs.push(await compressOne(image, edge, quality));
      onProgress(index + 1, images.length);
    }
    if (blobs.reduce((size, blob) => size + blob.size, 0) <= MAX_IMAGE_BYTES) return blobs;
  }
  throw new Error("图片压缩后仍超过 3MiB，请减少图片数量后重试。");
}
