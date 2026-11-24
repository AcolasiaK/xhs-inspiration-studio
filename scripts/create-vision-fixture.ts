// 无隐私的程序绘制静物图。测试要求不描述图中物体，以便检查实际识图。
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
<rect width="1200" height="800" fill="#f7f2e8"/>
<rect y="550" width="1200" height="250" fill="#dec6a1"/>
<ellipse cx="330" cy="598" rx="190" ry="32" fill="#bca482" opacity=".3"/>
<ellipse cx="815" cy="614" rx="240" ry="25" fill="#bca482" opacity=".3"/>
<path d="M205 320 L440 320 L420 570 Q325 615 225 570 Z" fill="#ce3c39"/>
<ellipse cx="322" cy="320" rx="118" ry="30" fill="#f9ddd0"/>
<ellipse cx="322" cy="322" rx="99" ry="21" fill="#683f28"/>
<path d="M444 365 C570 325 590 525 432 525" fill="none" stroke="#ce3c39" stroke-width="40"/>
<path d="M255 370 L270 520" stroke="#ee7970" stroke-width="13" stroke-linecap="round"/>
<path d="M620 505 L925 505 L975 580 L655 580 Z" fill="#254c9c"/>
<path d="M655 580 L975 580 L975 615 L655 615 Z" fill="#faf7e8"/>
<path d="M620 505 L655 580 L655 620 L620 545 Z" fill="#183b7e"/>
<path d="M650 620 L980 620" stroke="#254c9c" stroke-width="10"/>
<path d="M674 592 L962 592 M678 602 L964 602" stroke="#d3cbb9" stroke-width="3"/>
<ellipse cx="900" cy="440" rx="92" ry="62" transform="rotate(-15 900 440)" fill="#f4cc31"/>
<path d="M810 460 L798 451 L814 439 M985 420 L1000 426 L985 439" fill="#f4cc31"/>
<ellipse cx="890" cy="418" rx="48" ry="16" transform="rotate(-15 890 418)" fill="#ffe276"/>
<path d="M955 384 Q951 330 1010 340 Q1003 383 955 384" fill="#56864e"/>
</svg>`;
async function main() {
  await mkdir("test-results/fixtures", { recursive: true });
  await sharp(Buffer.from(drawing)).png().toFile("test-results/fixtures/vision-still-life.png");
  console.log("已生成不含个人信息的静物识图测试图片。");
}
main().catch(() => { console.error("测试图片创建失败。"); process.exitCode = 1; });
