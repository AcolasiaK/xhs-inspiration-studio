// 本地合成图，仅用于验证多图的视觉与顺序关联，不包含个人资料。
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const image = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#a7d7f5"/>
<circle cx="974" cy="145" r="88" fill="#f5c347"/>
<path d="M0 530 L300 200 L585 530 L850 315 L1200 575 L1200 800 L0 800 Z" fill="#77929c"/>
<path d="M208 300 L300 200 L391 305 L344 282 L300 303 L270 280 Z" fill="#f8f9f5"/>
<rect y="555" width="1200" height="245" fill="#71aa84"/>
<path d="M0 715 Q350 600 650 715 T1200 700 L1200 800 L0 800 Z" fill="#5e9a73"/>
<rect x="540" y="420" width="52" height="200" rx="8" fill="#806047"/>
<circle cx="566" cy="366" r="125" fill="#358458"/>
<circle cx="495" cy="425" r="80" fill="#459768"/>
<circle cx="630" cy="425" r="82" fill="#399263"/>
</svg>`;
async function main() {
  await mkdir("test-results/fixtures", { recursive: true });
  await sharp(Buffer.from(image)).png().toFile("test-results/fixtures/vision-landscape.png");
  console.log("已生成不含个人信息的多图视觉测试素材。");
}
main().catch(() => { console.error("测试图片创建失败。"); process.exitCode = 1; });
