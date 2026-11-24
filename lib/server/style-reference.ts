import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppError } from '../errors';
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, normalizeXhsReferenceLink, type StyleReferenceImage } from '../personal/style-learning';
import { cleanStyleReferenceImage } from './style-learning-images';

const run = promisify(execFile);
type BrowserReply = { ok?: boolean; targetId?: string; result?: unknown; path?: string };
type Browser = (args: string[], signal: AbortSignal) => Promise<BrowserReply>;
const browser: Browser = async (args, signal) => {
  try {
    const { stdout } = await run(join(homedir(), '.openclaw/bin/openclaw'), ['browser', '--browser-profile', 'openclaw', '--json', ...args], { signal, timeout: 35_000, maxBuffer: 200_000, env: { ...process.env, NO_COLOR: '1' } });
    const reply = JSON.parse(stdout) as BrowserReply;
    if (reply.ok === false) throw new Error();
    return reply;
  } catch {
    signal.throwIfAborted();
    throw new AppError('XHS_BROWSER', 'OpenClaw 浏览器连接失败，请检查网关；也可以直接粘贴正文。', 503);
  }
};
const pageSchema = z.object({ host: z.string(), id: z.string(), blocked: z.boolean(), title: z.string().max(1000), body: z.string().max(15000), imageIndexes: z.array(z.number().int().nonnegative()).max(100).default([]), video: z.boolean().default(false) });
const inspect = `() => {
 const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const n=document.querySelector('#noteContainer'),text=document.body.innerText.slice(0,5000);
 const t=s=>n?.querySelector(s)?.innerText?.trim()||'';
 return {host:location.hostname,id:location.pathname.match(/[a-f0-9]{24}/)?.[0]||'',
 blocked:/captcha|website-login/.test(location.pathname)||/安全验证|请完成验证|访问频次异常/.test(text)||Array.from(document.querySelectorAll('.login-container,.login-modal')).some(visible),
 title:t('.title').slice(0,1000),body:(t('#detail-desc')||t('.desc')).slice(0,15000),video:!!n?.querySelector('video'),
 imageIndexes:Array.from(n?.querySelectorAll('.note-slider .swiper-slide:not(.swiper-slide-duplicate)')||[]).filter(e=>e.querySelector('img')).map((e,i)=>Number(e.getAttribute('data-swiper-slide-index')??i)).filter(Number.isInteger)};
}`;

async function loadScreenshot(path: string): Promise<string> {
  const root = resolve(homedir(), '.openclaw/media/browser') + sep;
  const file = await realpath(path);
  if (!file.startsWith(root) || (await stat(file)).size > 20_000_000) throw new Error('Invalid screenshot');
  return cleanStyleReferenceImage(await readFile(file));
}

async function readImages(target: string, noteId: string, indices: number[], signal: AbortSignal, port: Browser, loadImage: (path: string) => Promise<string>) {
  const images: StyleReferenceImage[] = [], warnings: string[] = [];
  const unique = [...new Set(indices)].sort((a, b) => a - b);
  if (unique.length > MAX_REFERENCE_IMAGES) warnings.push(`本次只读取前 ${MAX_REFERENCE_IMAGES} 张图，其余可分批上传补充。`);
  for (const index of unique.slice(0, MAX_REFERENCE_IMAGES)) {
    signal.throwIfAborted();
    try {
      // Work only in this owned note tab. Wait for the selected slide's image,
      // then capture the visible slide, not a duplicate/previous thumbnail.
      const selected = await port(['evaluate', '--target-id', target, '--fn', `async () => {
        if(!['www.xiaohongshu.com','xiaohongshu.com'].includes(location.hostname)||!location.pathname.includes(${JSON.stringify(noteId)}))return false;
        const n=document.querySelector('#noteContainer'),slider=n?.querySelector('.note-slider'),swiper=slider?.swiper;
        if(!swiper)return false;
        if(swiper.params.loop)swiper.slideToLoop(${index},0);else swiper.slideTo(${index},0);
        const ready=()=>{const slide=slider.querySelector('.swiper-slide-active:not(.swiper-slide-duplicate)'),img=slide?.querySelector('.img-container img')||slide?.querySelector('img');
          const blocked=Array.from(document.querySelectorAll('.login-container,.login-modal')).some(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
          return !blocked&&swiper.realIndex===${index}&&!!img?.complete&&img.naturalWidth>0&&img.getBoundingClientRect().width>0;};
        for(let i=0;i<15;i++){if(ready())return true;await new Promise(r=>setTimeout(r,200));}return false;
      }`], signal);
      if (selected.result !== true) throw new Error('Image not ready');
      const capture = await port(['screenshot', target, '--element', '#noteContainer .note-slider .swiper-slide-active:not(.swiper-slide-duplicate)'], signal);
      if (!capture.path) throw new Error('Missing screenshot');
      const dataUrl = await loadImage(capture.path);
      signal.throwIfAborted();
      if (images.reduce((size, i) => size + i.dataUrl.length, 0) + dataUrl.length > MAX_REFERENCE_IMAGE_BYTES) {
        warnings.push('图片总量较大，已保留读取成功的图片；其余可分批上传。'); break;
      }
      images.push({ id: `reference-${index + 1}`, dataUrl, caption: '' });
    } catch {
      signal.throwIfAborted(); warnings.push(`第 ${index + 1} 张图片没有读到，可手动上传补充。`);
    }
  }
  return { images, warnings, imageCount: unique.length };
}

/** Opens only the user's supplied note in its own OpenClaw tab, never a search collector tab. */
export async function readStyleReference(link: string, signal: AbortSignal, port: Browser = browser, pause = (ms: number) => delay(ms, undefined, { signal }), loadImage = loadScreenshot) {
  let url: string;
  try { url = normalizeXhsReferenceLink(link); }
  catch (error) { throw new AppError('INVALID_LINK', (error as Error).message, 400); }
  const expected = new URL(url).hostname === 'www.xiaohongshu.com' ? new URL(url).pathname.match(/[a-f0-9]{24}/)?.[0] : undefined;
  let target: string | undefined, keepOpen = false;
  try {
    signal.throwIfAborted();
    await port(['start'], signal);
    target = (await port(['open', url], signal)).targetId;
    if (!target) throw new AppError('XHS_BROWSER', '无法打开笔记，请重试或粘贴正文。', 503);
    for (let attempt = 0; attempt < 2; attempt++) {
      await pause(attempt ? 1800 : 1000); signal.throwIfAborted();
      const page = pageSchema.parse((await port(['evaluate', '--target-id', target, '--fn', inspect], signal)).result);
      if (page.blocked) { keepOpen = true; throw new AppError('XHS_LOGIN', '请在 OpenClaw 浏览器完成登录或安全验证后重试；也可以粘贴正文。', 409); }
      if (page.host !== 'www.xiaohongshu.com' && page.host !== 'xiaohongshu.com') continue;
      if (!/^[a-f0-9]{24}$/.test(page.id) || (expected && expected !== page.id)) continue;
      if (page.body.trim().length < 20 && !page.imageIndexes.length) continue;
      const text = [page.title, page.body].filter(Boolean).join('\n\n');
      if (text.length > 12000) throw new AppError('REFERENCE_TOO_LONG', '笔记超过 12000 字，请粘贴希望学习的段落。', 400);
      const gallery = page.video ? { images: [], imageCount: 0, warnings: ['这是一篇视频笔记；本次只读取文字，未分析视频画面。可上传截图补充。'] } : await readImages(target, page.id, page.imageIndexes, signal, port, loadImage);
      if (!gallery.images.length && !page.video) gallery.warnings.push('没有读到笔记配图。可上传图片或截图后一起拆解。');
      if (text.trim().length < 20 && !gallery.images.length) throw new AppError('XHS_REFERENCE_UNAVAILABLE', '没有读到足够文案或配图，请上传图片或粘贴正文。', 422);
      signal.throwIfAborted();
      return { title: page.title, text, url: `https://www.xiaohongshu.com/explore/${page.id}`, ...gallery };
    }
    throw new AppError('XHS_REFERENCE_UNAVAILABLE', '没有读取到这篇笔记的完整正文，可能链接失效或页面尚未加载。请重试，或直接粘贴正文。', 422);
  } finally {
    if (target && !keepOpen) await port(['close', target], AbortSignal.timeout(5000)).catch(() => undefined);
  }
}
