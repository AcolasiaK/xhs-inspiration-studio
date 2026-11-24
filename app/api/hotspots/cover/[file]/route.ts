import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getServerConfig } from '@/lib/server/config';
import { assertAppAccess, assertLocalRequest } from '@/lib/server/guard';
import { xhsCoverDirectory } from '@/lib/server/xhs-hotspots-browser';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ file: string }> }) {
  try {
    if (!getServerConfig().localOnly) return new Response(null, { status: 404 });
    assertLocalRequest(request); assertAppAccess(request);
    const { file } = await params;
    if (!/^[a-f0-9]{24}-[a-f0-9]{16}\.jpg$/.test(file)) return new Response(null, { status: 404 });
    const bytes = await readFile(join(xhsCoverDirectory(), file));
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response(null, { status: 404 }); }
}
