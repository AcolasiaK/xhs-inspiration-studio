# 第三方组件与出处

仓库原创部分采用 [MIT 许可证](LICENSE)。下列组件及改编内容保留其上游的版权声明与条款。

| 组件或资料 | 在本项目中的用途 | 来源与许可 |
| --- | --- | --- |
| Humanizer-zh | 个人创作的正文润色规则。随仓保留原版说明、源版本记录和完整许可文本 | [上游项目](https://github.com/op7418/Humanizer-zh/tree/f4518a8eab97b8bfebc66a89d34320a89bef6930) · [MIT 许可证](vendor/humanizer-zh/LICENSE) |
| xiaohongshu-ingest | 热点笔记拆解的分析方法，项目实现位于 `lib/server/xhs-ingest-prompt.ts`。上游版本记录为 `d066d769` | [上游项目](https://github.com/chubbyguan/chubbyskills/tree/d066d7694d23045a39f8c3efc1b51ebb9ca7f867) · [MIT 许可证](docs/licenses/xiaohongshu-ingest-MIT.txt) |

Node.js 依赖由 npm 按 [package-lock.json](package-lock.json) 安装。各依赖包附带的许可证继续适用。`vendor/lodash-set-safe` 是调用 Lodash 的兼容包装。OpenClaw 作为使用者另行配置的浏览器工具运行。
