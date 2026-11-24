import "server-only";
import type { TravelResearch } from "../travel-research";
import type { BrowserSearchPort } from "./openclaw-browser";

export type PublicGuideResult = { sources: TravelResearch["sources"]; notice?: string };
type GuideTab = { read(url: string, selector: string): Promise<unknown> };

/** Navigate only the adapter's own tab. A late open can still return its ID after cancellation. */
export async function withPublicGuideTab(
  name: string, port: BrowserSearchPort, budgetMs: number, parentSignal: AbortSignal | undefined,
  lookup: (tab: GuideTab) => Promise<PublicGuideResult>,
): Promise<PublicGuideResult> {
  parentSignal?.throwIfAborted();
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(signal.reason); });
  signal.addEventListener("abort", rejectAbort, {once:true});
  const call = (args: string[]) => {
    signal.throwIfAborted();
    return Promise.race([port(args, signal), aborted]);
  };
  const close = (id: string) => {
    const cleanup = AbortSignal.timeout(3500);
    return Promise.race([port(["close", id], cleanup).catch(() => undefined),
      new Promise<void>(resolve => cleanup.addEventListener("abort", () => resolve(), {once:true}))]);
  };
  let target: string | undefined;
  let finished = false;
  try {
    await call(["start"]);
    signal.throwIfAborted();
    const opened = port(["open","about:blank"], AbortSignal.timeout(10_000)).then(reply => {
      if (finished && reply.targetId) void close(reply.targetId);
      else target = reply.targetId;
    });
    await Promise.race([opened, aborted]);
    if (!target) return {sources: [], notice: name + "检索标签未能打开。"};
    const id = target;
    return await lookup({async read(url, selector) {
      await call(["navigate", url, "--target-id", id]);
      const reply = await call(["evaluate", "--target-id", id, "--fn", selector]);
      return reply.result;
    }});
  } catch {
    parentSignal?.throwIfAborted();
    return {sources: [], notice: name + (timeout.aborted ? "读取超时。" : "页面暂时无法读取。")};
  } finally {
    finished = true;
    signal.removeEventListener("abort", rejectAbort);
    if (target) await close(target);
  }
}
