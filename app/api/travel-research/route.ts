import { z } from "zod";
import { isCloudMode } from "@/lib/cloud/mode";
import { assertOrigin, cloudError, readJson } from "@/lib/cloud/server/config";
import { requireUser } from "@/lib/cloud/server/auth";
import { shortLimit } from "@/lib/cloud/server/jobs";
import { assertAppAccess, assertLocalRequest, checkRateLimit } from "@/lib/server/guard";
import { searchTravelInfo } from "@/lib/server/travel-search";
import { AppError } from "@/lib/errors";
import { searchPersonalBackground } from "@/lib/server/personal-search";

export const runtime = "nodejs";
export const maxDuration = 100;
const inputSchema = z.object({
  place: z.string().trim().max(100),
  enabled: z.literal(true),
  scope: z.literal("personal").optional(),
  guideScope: z.enum(["destination", "segment"]).optional(),
}).strict().refine(input => !input.guideScope || input.scope === "personal");

async function researchResponse(request: Request, signal: AbortSignal, standardDeadline: AbortSignal) {
  signal.throwIfAborted();
  if (isCloudMode()) {
    assertOrigin(request);
    const user = await requireUser(request, {requireIdentity:true});
    await shortLimit(user.id);
  } else {
    assertLocalRequest(request);
    assertAppAccess(request);
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) throw new AppError("INVALID_ORIGIN", "请从本工具页面操作。", 403);
    checkRateLimit("travel_research", 30);
  }
  const input = inputSchema.safeParse(await readJson(request, 4096));
  signal.throwIfAborted();
  if (!input.success) throw new AppError("INVALID_FORM", "请检查检索地点后再试。", 400);
  const {place, guideScope} = input.data;
  const localGuide = input.data.scope === "personal" && !isCloudMode();
  const searchSignal = localGuide ? signal : AbortSignal.any([signal, standardDeadline]);
  try {
    const research = input.data.scope === "personal"
      ? await searchPersonalBackground({
          query:place, enabled:true, signal:searchSignal,
          wholeDestination:guideScope === undefined ? undefined : guideScope === "destination",
        })
      : await searchTravelInfo({place, enabled:true, signal:searchSignal});
    return Response.json({research}, {headers:{"Cache-Control":"private, no-store"}});
  } catch (error) {
    if (!localGuide && standardDeadline.aborted && !signal.aborted) throw new AppError("TIMEOUT", "检索超时，可以重试。", 504);
    throw error;
  }
}

/** A user-initiated refresh only searches; the client decides whether the result still fits the draft. */
export async function POST(request: Request) {
  // Local guide search may return partial evidence at 90s. Allow time to receive it.
  const deadline = AbortSignal.timeout(95_000);
  const standardDeadline = AbortSignal.timeout(60_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(request.signal.aborted
      ? new AppError("CANCELLED", "已取消检索。", 499)
      : new AppError("TIMEOUT", "攻略检索超时，可以重试。", 504));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, {once:true});
  });
  try {
    return await Promise.race([stopped, researchResponse(request, signal, standardDeadline)]);
  } catch (error) {
    if (isCloudMode()) return cloudError(error);
    const known = error instanceof AppError ? error : new AppError("SERVER_ERROR", "资料更新暂时失败，原内容已保留。", 500);
    return Response.json({error:{code:known.code,message:known.message}}, {status:known.status,headers:{"Cache-Control":"no-store"}});
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
