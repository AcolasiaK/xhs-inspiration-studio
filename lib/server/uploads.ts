import sharp from "sharp";
import { IMAGE_TYPES, MAX_EDGE, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from "../constants";
import { requestSchema } from "../schema";
import { AppError } from "../errors";

export async function readBoundedFormData(request: Request, signal?: AbortSignal): Promise<FormData> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) throw new AppError("INVALID_FORM", "请使用图片上传表单提交。", 415);
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new AppError("TOO_LARGE", "上传内容过大，请减少图片。", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("EMPTY_FORM", "没有收到上传内容。");
  // 请求取消或服务端总时限到期时，不继续读取上传流。
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AppError("UPLOAD_INTERRUPTED", "上传已中断。", 499);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new AppError("TOO_LARGE", "上传内容过大，请减少图片。", 413);
      }
      chunks.push(value);
    }
    return await new Response(Buffer.concat(chunks), { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_FORM", "上传内容无法读取，请重新选择图片。");
  } finally { signal?.removeEventListener("abort", cancelReader); reader.releaseLock(); }
}

export async function parseUpload(form: FormData) {
  let raw: unknown;
  try { raw = JSON.parse(String(form.get("payload"))); } catch { throw new AppError("INVALID_FORM", "创作要求无法读取，请重新提交。"); }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_FORM", "请填写主题，并上传 1–9 张有效图片；检查表单长度和选项。");
  const images = await parseImageFiles(form, parsed.data.imageIds);
  return { ...parsed.data, images };
}

/** Shared decoder also supports optional images for personal creation. */
export async function parseImageFiles(form: FormData, imageIds: string[]) {
  const files = form.getAll("images");
  if (files.length !== imageIds.length) throw new AppError("INVALID_IMAGES", "图片数量与上传信息不一致，请重试。");
  let total = 0;
  const images: { id: string; dataUrl: string }[] = [];
  for (const [index, file] of files.entries()) {
    if (!(file instanceof File) || !IMAGE_TYPES.includes(file.type)) throw new AppError("INVALID_IMAGE_TYPE", "图片仅支持 JPEG、PNG 和 WebP。");
    if (!file.size || file.size > MAX_FILE_BYTES) throw new AppError("TOO_LARGE", "每张图片须非空且不超过 5MB。", 413);
    total += file.size;
    if (total > MAX_IMAGE_BYTES) throw new AppError("TOO_LARGE", "压缩后图片总量超过 3MiB，请减少图片。", 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const pipeline = sharp(bytes, { limitInputPixels: 24_000_000, failOn: "warning" });
      const meta = await pipeline.metadata();
      const types: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
      if (!meta.format || types[meta.format] !== file.type || (meta.pages ?? 1) > 1) throw new Error("invalid image");
      // 完整解码再编码，避免仅凭扩展名/MIME 接受伪装或损坏文件，同时移除元数据。
      const clean = await pipeline.rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      images.push({ id: imageIds[index], dataUrl: `data:image/jpeg;base64,${clean.toString("base64")}` });
    } catch { throw new AppError("INVALID_IMAGE", `第 ${index + 1} 张图片无法读取，请使用完整的静态 JPEG、PNG 或 WebP 图片（不超过 2400 万像素）。`); }
  }
  return images;
}
