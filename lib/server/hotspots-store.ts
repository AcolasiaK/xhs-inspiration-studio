import type { AiSource } from "./ai-source";
import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import type { StylePreferences } from '../styles';
import { collectBaiduHotspots, normalizeHotspotCollection, hotspotSourceErrorMessage } from './hotspots-source';
import { HOTSPOT_SOURCE, HOTSPOT_SOURCE_KEY, hotspotSourceMetadata, hotspotSelectionNotice } from '../hotspot-metadata';
import { generateHotspotSuggestions } from './hotspots-ai';
import type { Hotspot, HotspotCollection, HotspotState, HotspotSuggestion } from './hotspots-types';

import { cachedHotspotSchema } from './hotspots-cache-schema';

const validDate=z.string().max(64).refine(value=>Number.isFinite(Date.parse(value)));
const savedSchema = z.object({ version: z.literal(1), sourceKey:z.string().max(80).optional(), lastAttemptSourceKey:z.string().max(80).optional(), sourceCount:z.number().int().min(0).optional(), filteredCount:z.number().int().min(0).optional(), items: z.array(cachedHotspotSchema).max(10), lastSuccessAt:validDate.nullable(), lastAttemptAt:validDate.nullable(), error:z.string().max(300).nullable(), sources:z.array(z.object({name:z.string().max(120),status:z.enum(['success','error']),count:z.number(),error:z.string().max(200).optional()})).max(10), suggestions:z.array(z.object({hotspotId:z.string().max(64),topic:z.string().max(150),angle:z.string().max(300),headline:z.string().max(120),imageIdea:z.string().max(250),reason:z.string().max(300)})).max(5), suggestionGeneratedAt:validDate.nullable(),suggestionError:z.string().max(300).nullable(),suggestionLastAttemptAt:validDate.nullable().optional(),suggestionRequestId:z.string().uuid().nullable().optional(),suggestionErrorCode:z.string().max(64).nullable().optional(),suggestionItems:z.array(cachedHotspotSchema).max(10).optional(),suggestionSourceAt:validDate.nullable().optional() });
type Saved = z.infer<typeof savedSchema>;
const blank = (): Saved => ({version:1,items:[],lastSuccessAt:null,lastAttemptAt:null,error:null,sources:[],suggestions:[],suggestionGeneratedAt:null,suggestionError:null});
export const beijingDay = (date: Date) => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
type Dependencies = { file: string; now: () => Date; collect: (now: string) => Promise<Hotspot[] | HotspotCollection>; suggest: (items: Hotspot[],style: StylePreferences,signal?: AbortSignal,aiSource?: AiSource) => Promise<HotspotSuggestion[]> };
export class HotspotsStore {
  private saved: Saved = blank();
  private initialized: Promise<void> | null = null;
  private pending: Promise<void> | null = null;
  private pendingSuggestions: Promise<void> | null = null;
  private pendingStyle: string | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private persistent = true;
  scheduler = false;
  constructor(private deps: Dependencies) {}
  /** Keep cache/locks/timer identity, but never retain callbacks from an older dev module. */
  static refreshImplementation(store:HotspotsStore, dependencies:Pick<Dependencies,'collect'|'suggest'>) {
    // These are ordinary TS-private data fields, shared with the prior implementation.
    // In-flight calls have already captured their callback and request snapshot.
    if(Object.getPrototypeOf(store)!==HotspotsStore.prototype)Object.setPrototypeOf(store,HotspotsStore.prototype);
    store.deps={...store.deps,...dependencies};
    return store;
  }
  private load() {
    return this.initialized ??= (async () => {
      try { const text=await readFile(this.deps.file,'utf8'); if (text.length > 1_000_000) throw new Error(); const parsed=savedSchema.safeParse(JSON.parse(text)); if (parsed.success) this.saved=parsed.data; else this.saved.error='本机热点缓存损坏，已保留原文件；请手动更新。'; }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.saved.error='无法读取本机热点缓存，原文件未被覆盖。'; }
    })();
  }
  private async persist() {
    const write = this.persistQueue.catch(()=>undefined).then(async()=>{
      try {
        const folder=join(this.deps.file,'..'); await mkdir(folder,{recursive:true});
        const temporary=`${this.deps.file}.${randomUUID()}.tmp`; await writeFile(temporary,JSON.stringify(this.saved),'utf8'); await rename(temporary,this.deps.file); this.persistent=true;
      } catch { this.persistent=false; }
    });
    this.persistQueue=write; await write;
  }
  async state(includeSuggestions=true): Promise<HotspotState> {
    await this.load();
    const s=this.saved;
    return {items:s.items,lastSuccessAt:s.lastSuccessAt,lastAttemptAt:s.lastAttemptAt,updating:Boolean(this.pending),error:s.error,sources:s.sources,sourceCount:s.sourceCount,filteredCount:s.filteredCount,selectionNotice:s.sourceKey===HOTSPOT_SOURCE_KEY?hotspotSelectionNotice(s.sourceCount,s.items.length):null,...hotspotSourceMetadata(s.sourceKey,Boolean(s.items.length)),
      suggestions:includeSuggestions?s.suggestions:[],suggestionGeneratedAt:includeSuggestions?s.suggestionGeneratedAt:null,suggestionError:includeSuggestions?s.suggestionError:null,
      suggestionLastAttemptAt:includeSuggestions?s.suggestionLastAttemptAt??null:null,suggestionRequestId:includeSuggestions?s.suggestionRequestId??null:null,suggestionErrorCode:includeSuggestions?s.suggestionErrorCode??null:null,
      suggestionItems:includeSuggestions?(s.suggestionItems??s.items):[],suggestionSourceAt:includeSuggestions?(s.suggestionSourceAt??s.lastSuccessAt):null,
      suggestionLocked:!includeSuggestions && Boolean(s.suggestions.length),scheduler:this.scheduler?'running':'disabled',storage:this.persistent?'disk':'memory'};
  }
  async update(force=false): Promise<HotspotState> {
    await this.load();
    if (this.pending) { await this.pending; return this.state(); }
    const now=this.deps.now();
    if (!force && this.saved.sourceKey===HOTSPOT_SOURCE_KEY && this.saved.lastSuccessAt && beijingDay(new Date(this.saved.lastSuccessAt))===beijingDay(now)) return this.state();
    // Failed automatic attempts are limited to one per 30 minutes; manual force may retry.
    if (!force && this.saved.lastAttemptSourceKey===HOTSPOT_SOURCE_KEY && this.saved.lastAttemptAt && now.getTime()-new Date(this.saved.lastAttemptAt).getTime()<30*60_000) return this.state();
    this.pending=(async () => {
      const collectedAt=now.toISOString(); this.saved.lastAttemptAt=collectedAt; this.saved.lastAttemptSourceKey=HOTSPOT_SOURCE_KEY;
      try {
        const {items,sourceCount,filteredCount}=normalizeHotspotCollection(await this.deps.collect(collectedAt));
        this.saved={...this.saved,sourceKey:HOTSPOT_SOURCE_KEY,items,sourceCount,filteredCount,lastSuccessAt:collectedAt,error:null,sources:[{name:HOTSPOT_SOURCE,status:'success',count:items.length}],suggestionItems:this.saved.suggestionItems??this.saved.items,suggestionSourceAt:this.saved.suggestionSourceAt??this.saved.lastSuccessAt};
      } catch (error) {
        const message=hotspotSourceErrorMessage(error);
        this.saved.error=message+(this.saved.items.length?' 当前保留上次成功的数据与采集时间。':' 当前没有可展示的热点。');
        this.saved.sources=[{name:HOTSPOT_SOURCE,status:'error',count:0,error:message}];
      }
      await this.persist();
    })();
    try { await this.pending; } finally { this.pending=null; }
    return this.state();
  }
  async suggest(style: StylePreferences, aiSource: AiSource = 'relay', signal?: AbortSignal, requestId?:string): Promise<HotspotState> {
    await this.load();
    if (signal?.aborted) throw new AppError('CANCELLED','本次生成已取消，已有建议保留。',499);
    const styleKey=JSON.stringify({style,selection:typeof aiSource==="string"?aiSource:{owner:aiSource.owner,id:aiSource.profile?.id,revision:aiSource.profile?.revision}});
    if (this.pendingSuggestions) {
      if (this.pendingStyle !== styleKey) throw new AppError('SUGGEST_BUSY','另一种风格或 AI 来源的建议正在生成，请稍后再试。',409);
      await this.pendingSuggestions;
      if (signal?.aborted) throw new AppError('CANCELLED','本次生成已取消，已有建议保留。',499);
      return this.state();
    }
    const items=this.saved.items, version=this.saved.lastSuccessAt, itemSnapshot=JSON.stringify(this.saved.items);
    if (!items.length) throw new AppError('NO_HOTSPOTS','没有可用热点，暂不能生成建议，请先更新。',400);
    this.pendingStyle=styleKey;
    this.pendingSuggestions=(async()=>{
      this.saved.suggestionLastAttemptAt=this.deps.now().toISOString();this.saved.suggestionRequestId=requestId??null;
      this.saved.suggestionError=null;this.saved.suggestionErrorCode=null;
      try {
        const suggestions=await this.deps.suggest(items,style,signal,aiSource);
        if (signal?.aborted) throw new AppError('CANCELLED','本次生成已取消，已有建议保留。',499);
        if (version !== this.saved.lastSuccessAt || itemSnapshot !== JSON.stringify(this.saved.items)) throw new AppError('STALE_HOTSPOTS','热点已更新，请重新生成建议。',409);
        this.saved.suggestions=suggestions;this.saved.suggestionGeneratedAt=this.deps.now().toISOString();this.saved.suggestionError=null;this.saved.suggestionErrorCode=null;this.saved.suggestionItems=structuredClone(items);this.saved.suggestionSourceAt=version;
      } catch(error) {
        const known=error instanceof AppError?error:new AppError('AI_FAILED','AI 建议生成失败，请稍后重试。',502);
        this.saved.suggestionError=known.message;this.saved.suggestionErrorCode=known.code; await this.persist(); throw known;
      }
      await this.persist();
    })();
    try { await this.pendingSuggestions; } finally { this.pendingSuggestions=null; this.pendingStyle=null; }
    return this.state();
  }
}
type GlobalStore = typeof globalThis & { __xhsHotspotsStore?: HotspotsStore; __xhsHotspotsTimer?: ReturnType<typeof setInterval> };
export function getHotspotsStore() {
  const global = globalThis as GlobalStore;
  if(global.__xhsHotspotsStore)return HotspotsStore.refreshImplementation(global.__xhsHotspotsStore,{collect:collectBaiduHotspots,suggest:generateHotspotSuggestions});
  return global.__xhsHotspotsStore = new HotspotsStore({file:join(process.cwd(),'.local-data','hotspots.json'),now:()=>new Date(),collect:collectBaiduHotspots,suggest:generateHotspotSuggestions});
}
export function startHotspotsScheduler() {
  if (process.env.VERCEL || process.env.GENERATION_TIMEOUT_PROFILE !== 'local') return;
  const global=globalThis as GlobalStore, store=getHotspotsStore(); store.scheduler=true;
  if (!global.__xhsHotspotsTimer) {
    void store.update(false).catch(()=>undefined);
    global.__xhsHotspotsTimer=setInterval(()=>{void store.update(false).catch(()=>undefined);},60_000);
    global.__xhsHotspotsTimer.unref();
  }
}
