import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import { AppError } from '../errors';
import { savedAnalysisSchema, xhsIngestAnalysisSchema, type XhsAnalysis, type XhsNote } from '../xhs-hotspots';
import { createProvider } from './ai/provider';
import type { AiSource } from './ai-source';
import { xhsCoverDirectory } from './xhs-hotspots-browser';
import { XHS_INGEST_PROMPT } from './xhs-ingest-prompt';

export async function analyzeXhsNote(note: XhsNote, source: AiSource, signal?: AbortSignal): Promise<XhsAnalysis> {
  const client = await createProvider(source);
  let image: string | null = null;
  if (note.coverFile && /^[a-f0-9]{24}-[a-f0-9]{16}\.jpg$/.test(note.coverFile) && client.profile.imageTest.status === 'passed') {
    try { const bytes = await readFile(join(xhsCoverDirectory(), note.coverFile)); if (bytes.length < 2_000_000) image = `data:image/jpeg;base64,${bytes.toString('base64')}`; } catch { /* Text-only analysis explicitly discloses the missing image. */ }
  }
  const { title, author, body, tags, publishedAt, collectedAt, likes, collects, comments, dateLabel } = note;
  const response = await client.responses.parse({ model: client.model, store: false, max_output_tokens: 7500,
    input: [
      { role: 'system', content: XHS_INGEST_PROMPT },
      { role: 'user', content: [ { type: 'input_text', text: JSON.stringify({ title, author, body, tags, publishedAt, dateLabel, collectedAt, likes, collects, comments, coverProvided: Boolean(image) }) }, ...(image ? [{ type: 'input_image' as const, image_url: image, detail: 'auto' as const }] : []) ] },
    ], text: { format: zodTextFormat(xhsIngestAnalysisSchema, 'xhs_ingest_analysis') },
  }, { signal });
  if (!response.output_parsed) throw new AppError('INVALID_RESULT', '拆解结果不完整，请重试；已有拆解保留。', 502);
  const content = xhsIngestAnalysisSchema.parse(response.output_parsed);
  // Enforce missing-evidence disclosure independently of model compliance.
  if (!image) content.cover = '未读取封面，无法判断实际画面。当前配置未验证图片能力或封面未成功采集。可在 AI 设置中验证图片能力后重新拆解。';
  return savedAnalysisSchema.parse({ noteId: note.id, fingerprint: note.fingerprint, generatedAt: new Date().toISOString(), model: client.model, method: 'xiaohongshu-ingest', methodVersion: 1, coverObserved: Boolean(image), content });
}
