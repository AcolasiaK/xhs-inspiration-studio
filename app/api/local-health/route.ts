import { assertLocalRequest } from '@/lib/server/guard';
import { getServerConfig } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness only: no AI, data writes, credentials, environment dump or external I/O.
export function GET(request: Request) {
  if (!getServerConfig().localOnly) return new Response(null, { status: 404 });
  try { assertLocalRequest(request); }
  catch { return new Response(null, { status: 403 }); }
  return Response.json({ app: 'xhs-inspiration-studio', status: 'ok',
    instance: process.env.XHS_LOCAL_INSTANCE || '', release: process.env.XHS_LOCAL_RELEASE || '' },
  { headers: { 'Cache-Control': 'no-store' } });
}
