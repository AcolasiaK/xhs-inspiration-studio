import { hasCaptionHeading, usesEmotionalCaptions } from './captions';
import { isTitleWithinLimit, XHS_TITLE_LIMIT } from '../xhs-title';
import { polishOutputSchema, polishResponseSchema, type PolishField, type PolishRequest } from './polish-schema';

const count=(s:string)=>Array.from(s.replace(/\s/gu,'')).length;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function protectedParts(text:string){
 const patterns=[/https?:\/\/[^\s<>）)」』”]+/gu,/[“「『][^”」』\n]+[”」』]|"[^"\n]+"|《[^》\n]+》/gu,/(?:周|星期)[一二三四五六日天末]|[零〇一二两三四五六七八九十百千万]+(?:年|月|日|号|小时|分钟|秒|天|周|公里|米|元|次|个|项|岁)|今天|昨天|明天|前天|后天|今年|去年|明年|本周|上周|下周|今晚|今早|凌晨|上午|中午|下午|傍晚|晚上|早晨/gu,/(?:来源|出处|摘自|引自|作者)[：:][^\n]+|[—–]{1,2}\s*[\p{L}·]{2,25}(?:\s*《[^》]+》)?/gu,/`[^`\n]+`|#[\p{L}\p{N}_]+/gu];
 // Keep signs and units with the value, while allowing harmless spacing changes.
 const numbers=/[+\-−]?\d+(?:[.,:/-]\d+)*(?:\s*(?:%|％|万元|亿元|美元|人民币|元|平方公里|平方米|公里|千米|厘米|毫米|平米|米|千克|公斤|克|斤|吨|毫升|升|分钟|小时|秒|时|分|天|日|号|月|年|周|岁|次|个|项|步|人|℃|°C|度|点))?/gu;
 return [...patterns.map(re=>[...text.matchAll(re)].map(m=>m[0]).sort()),[...text.matchAll(numbers)].map(m=>m[0].replace(/\s/gu,'')).sort()];
}
/** Mechanical protection complements the semantic editing instructions and preview. */
export function validatePolishOutput(request:PolishRequest,value:unknown):PolishField[]{
 const output=polishOutputSchema.safeParse(value);
 const parsed=output.success?output:polishResponseSchema.safeParse(value);
 if(!parsed.success||!same(parsed.data.fields.map(f=>f.key),request.fields.map(f=>f.key)))throw new Error('润色结果字段不完整或顺序有误，原文保留。');
 const fields=parsed.data.fields;
 fields.forEach((field,i)=>{
  const before=request.fields[i].text,after=field.text;
  const basis=request.bases.find(b=>b.keys.includes(field.key))!;
  if(!before.trim()&&after!==before)throw new Error('润色结果补写了原本不存在的内容，原文保留。');
  if(before.trim()&&!after.trim())throw new Error('润色结果遗漏了原有内容，原文保留。');
  if(!same(protectedParts(before),protectedParts(after)))throw new Error('润色改变了数字、时间、引用或其他受保护信息，原文保留。');
  if(/可能|也许|或许|似乎|据称|推测|不确定|尚未确认/u.test(before)&&!/可能|也许|或许|似乎|据称|推测|不确定|尚未确认/u.test(after))throw new Error('润色结果可能丢失了原文的确定程度，请重新润色；原文保留。');
  if(/尚未|还未|还没有|尚无|未确认|未验证|未完成/u.test(before)&&!/尚未|还未|还没有|尚无|未确认|未验证|未完成/u.test(after))throw new Error('润色结果改变了未完成或未核实的状态，原文保留。');
  if(before!==after&&/^(?:以下是|下面是|润色后[：:]|修改说明[：:]|已去除\s*AI\s*味)/iu.test(after.trim()))throw new Error('润色结果包含额外说明，请重新润色；原文保留。');
  if(field.key==='body'){
   if(count(before)>=80&&count(after)<Math.floor(count(before)*.75))throw new Error('润色删减过多，可能损失正文信息；原文保留。');
   if(count(before)>=120&&before.split(/\n\s*\n/u).length>1&&after.split(/\n\s*\n/u).length<2)throw new Error('润色未保留正文段落，原文保留。');
  }
  if(field.key.startsWith('title:')&&!isTitleWithinLimit(after))throw new Error(`润色标题超过 ${XHS_TITLE_LIMIT} 字，原文保留。`);
  if(field.key.startsWith('cover:')&&after.length>(field.key==='cover:headline'?150:250))throw new Error('封面文案超过长度限制，原文保留。');
  if(field.key.startsWith('caption:')&&after!==before){
   if(after.length>500||hasCaptionHeading(after))throw new Error('润色配文含小标题或超过长度限制，原文保留。');
   if(!usesEmotionalCaptions(basis.input)&&before.split(/\r?\n/u).filter(s=>s.trim()).length>=2&&after.split(/\r?\n/u).filter(s=>s.trim()).length<2)throw new Error('润色未保留原有配文分行，原文保留。');
   if(count(before)>=80&&count(after)<Math.floor(count(before)*.75))throw new Error('润色删减了过多配文，原文保留。');
  }
 });
 const titles=fields.filter(f=>f.key.startsWith('title:')).map(f=>f.text.trim().normalize('NFKC').toLocaleLowerCase('und')).filter(Boolean);
 if(new Set(titles).size!==titles.length)throw new Error('润色后的标题重复，原文保留。');
 return fields;
}

export function polishHasChanges(before:PolishField[],after:PolishField[]){return !same(before.map(f=>[f.key,f.text.trim()]),after.map(f=>[f.key,f.text.trim()]));}
