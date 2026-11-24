import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../errors';
import { xhsDataDirectory } from './xhs-data-directory';
import { formatXhsRuleIssues, DEFAULT_XHS_RULES, xhsRulesSchema, xhsRulesVersionSchema, type XhsRulesVersion } from '../xhs-hotspot-rules';

export function defaultRulesVersion(): XhsRulesVersion {
  return { revision: createHash('sha256').update(JSON.stringify(DEFAULT_XHS_RULES)).digest('hex'), updatedAt: null, rules: structuredClone(DEFAULT_XHS_RULES) };
}
export class XhsRulesStore {
  constructor(private file: string) {}
  async read(): Promise<XhsRulesVersion> {
    try { const text = await readFile(this.file, 'utf8'); if (text.length > 600_000) throw new Error(); return xhsRulesVersionSchema.parse(JSON.parse(text)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultRulesVersion(); throw new AppError('XHS_RULES_STORAGE', '热点规则无法读取，原文件保留。请检查本机存储后重试。', 503); }
  }
  async save(input: unknown, expectedRevision: string): Promise<XhsRulesVersion> {
    const parsed = xhsRulesSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_RULES', formatXhsRuleIssues(parsed.error.issues), 400);
    await mkdir(dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppError('XHS_RULES_STORAGE', '规则无法保存，请检查磁盘权限。', 503);
      // Only reclaim a lock whose owning process has exited.
      try { const pid = Number(await readFile(lock, 'utf8')); if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lock); return this.save(input, expectedRevision); } } } } catch { /* Existing lock remains intact. */ }
      throw new AppError('XHS_RULES_BUSY', '另一窗口正在保存规则，请稍后重试。', 409);
    }
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      await handle.writeFile(String(process.pid));
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new AppError('XHS_RULES_CONFLICT', '规则已被另一窗口修改。你的编辑已保留，请重新载入后合并再保存。', 409);
      if (JSON.stringify(current.rules) === JSON.stringify(parsed.data)) return current;
      await copyFile(this.file, this.file + '.before-dynamic', 1).catch(e => { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; });
      // Removing a category means archiving it; its rules and historical results stay recoverable.
      for (const [id, category] of Object.entries(current.rules.categories)) if (!parsed.data.categories[id]) parsed.data.categories[id] = { ...category, archived: true, enabled: false };
      const merged = xhsRulesSchema.safeParse(parsed.data);
      if (!merged.success) throw new AppError('INVALID_RULES', formatXhsRuleIssues(merged.error.issues), 400);
      const next = { revision: randomUUID(), updatedAt: new Date().toISOString(), rules: merged.data };
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 }); await rename(temporary, this.file); return next;
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('XHS_RULES_STORAGE', '保存失败，原规则仍保留，请检查本机存储。', 503); }
    finally { await handle.close(); await unlink(lock); await unlink(temporary).catch(() => undefined); }
  }
}
export const getXhsRulesStore = () => new XhsRulesStore(join(xhsDataDirectory(), 'xhs-hotspots-rules.json'));
