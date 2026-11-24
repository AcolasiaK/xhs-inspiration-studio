import type { ContentResult } from "./schema";

const captions = [
  ["把周末调成慢速", "给自己留一点\n不赶时间的空白。"],
  ["日常里的一点小确幸", "一杯咖啡\n也可以是今天的小小仪式。"],
  ["在喜欢的角落放空", "暂时放下待办\n认真感受此刻。"],
];

// 固定文字样例，只绑定 ID 以演示逐图编辑；不会读取图片内容或模仿真实识图。
export function createDemoResult(imageIds: string[]): ContentResult {
  return {
    titles: ["周末的正确打开方式：慢一点，再慢一点", "给生活留白，从一杯咖啡开始", "不赶路的周末，也很值得记录", "把周末留给咖啡和自己", "今日小事：认真休息，好好生活"],
    coverCopy: { headline: "今天，慢一点", subline: "把周末还给自己 / WEEKEND NOTES" },
    imageCaptions: imageIds.map((imageId, i) => ({ imageId, headline: captions[i % captions.length][0], description: captions[i % captions.length][1] })),
    body: "有时候，周末最好的安排，就是不把它安排得太满。☕\n\n选一个喜欢的角落，点一杯咖啡，把手机暂时放在一边。窗外的光线慢慢移动，时间好像也跟着变柔软了。\n\n不必每一次出门都有目的，也不必把休息变成另一张待办清单。留一点空白，看看窗外，翻几页书，或者就这样什么也不做。\n\n那些看起来很普通的瞬间，也值得被认真记录。慢下来，才发现生活里的小事其实很好看。\n\n你的周末，有没有一个想留给自己的小时？",
    hashtags: ["#周末日常", "#咖啡时光", "#生活碎片", "#慢生活", "#给生活留白", "#周末随记", "#咖啡日常", "#生活记录", "#休息时间", "#日常仪式感"],
    warnings: ["以上为固定咖啡主题样例，未分析上传图片，也未依据表单要求生成。真实生成需要配置 API 密钥。"],
  };
}
