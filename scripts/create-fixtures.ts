import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

async function main() {
  await mkdir("test-results/fixtures", { recursive: true });
  for (const [name, background] of [["coral", "#e9a092"], ["sage", "#98b6a2"], ["cream", "#ead6b6"]]) {
    await sharp({ create: { width: 1800, height: 1200, channels: 3, background } }).png().toFile(`test-results/fixtures/${name}.png`);
  }
  await writeFile("test-results/fixtures/too-large.png", Buffer.alloc(5 * 1024 * 1024 + 1));
  await writeFile("test-results/fixtures/invalid.txt", "This is not an image.");
  console.log("已生成本地合成测试图片，仅用于验证上传，不包含私人照片。");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
