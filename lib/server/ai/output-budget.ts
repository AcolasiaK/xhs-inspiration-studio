import 'server-only';
import { AppError } from '@/lib/errors';

/** Only visible output text is retained, never reasoning items or the upstream response. */
export class OutputBudgetError extends AppError {
  #text: string;
  constructor(readonly limit: number, readonly reason: 'exhausted' | 'unsupported', visibleText = '') {
    super(reason === 'exhausted' ? 'INCOMPLETE' : 'OUTPUT_BUDGET_UNSUPPORTED', reason === 'exhausted'
      ? `本次输出达到 ${limit.toLocaleString('en-US')} token 上限，返回内容被截断。输入和上次结果保留，请选择提高本次上限后重试，或先调整参考。`
      : `AI 服务不接受本次 ${limit.toLocaleString('en-US')} token 输出上限。输入和已有结果保留，可以修改本次上限后重试。`, 502);
    this.#text = visibleText;
  }
  visibleText() { return this.#text; }
}
