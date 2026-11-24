import 'server-only';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function xhsDataDirectory() {
  if (process.env.XHS_HOTSPOTS_DIR) return process.env.XHS_HOTSPOTS_DIR;
  const legacy = join(process.cwd(), '.local-data'), shared = join(legacy, 'xhs-hotspots');
  return lstatSync(shared, { throwIfNoEntry: false }) ? shared : legacy;
}
