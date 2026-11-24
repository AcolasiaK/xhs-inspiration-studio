import "server-only";
import { AppError } from "@/lib/errors";
/** Bound simultaneous large bodies per process without imposing a daily quota. */
export class ConcurrencyGate {
  private total = 0;
  private readonly users = new Map<string, number>();
  constructor(private readonly maxTotal: number, private readonly maxPerUser: number) {}
  enter(userId: string): () => void {
    const current = this.users.get(userId) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerUser) throw new AppError("RATE_LIMIT", "云端保存正在处理，请稍后重试。当前内容仍保留。", 429);
    this.total++; this.users.set(userId, current + 1);
    let released = false;
    return () => { if (released) return; released = true; this.total--; const remaining = (this.users.get(userId) ?? 1) - 1; if (remaining) this.users.set(userId, remaining); else this.users.delete(userId); };
  }
}
