import "server-only";
import sharp from 'sharp';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import type { Profile, Probe } from '@/lib/ai-config';
import { AppError } from '@/lib/errors';
import { createProvider } from './provider';
export async function probeProfile(p:Profile,kind:'text'|'image',signal?:AbortSignal,transport?:typeof fetch):Promise<Probe>{
 try{const client=await createProvider({owner:'probe',profile:p},{testImage:true,transport});
 const colors=['red','green','blue','yellow','magenta','cyan'] as const;
 const chosen=Array.from({length:6},()=>colors[randomInt(colors.length)]);
 const tiles=kind==='image'?await Promise.all(chosen.map(async(color,i)=>({input:await sharp({create:{width:96,height:96,channels:3,background:color}}).png().toBuffer(),left:(i%3)*96,top:Math.floor(i/3)*96}))):[];
 const input=kind==='image'?[{type:'input_text' as const,text:'Read the six colored tiles in this image, left to right in the top row, then left to right in the bottom row. Return JSON {"value":"color1,color2,color3,color4,color5,color6"}. Use only red, green, blue, yellow, magenta, cyan.'},{type:'input_image' as const,image_url:'data:image/png;base64,'+(await sharp({create:{width:288,height:192,channels:3,background:'white'}}).composite(tiles).png().toBuffer()).toString('base64'),detail:'auto' as const}]:[{type:'input_text' as const,text:'Return JSON {"value":"OK"}.'}];
 const schema=z.object({value:z.string()});
 const r=await client.responses.parse({model:p.model,store:false,max_output_tokens:p.maxOutputTokens,input:[{role:'user',content:input}],text:{format:zodTextFormat(schema,'connection_test')}},{signal});
 if(kind==='image'?r.output_parsed.value.toLowerCase().replace(/\s/g,'')!==chosen.join(','):r.output_parsed.value!=="OK")throw new AppError('TEST_FAILED',kind==='image'?'模型未正确识别测试图片，本次图片能力未通过。':'模型未按要求返回测试结果。',502);
 return {status:'passed',at:new Date().toISOString(),message:kind==='image'?'测试图片识别正确且 JSON 结构通过；复杂照片仍需逐图核对。':'文字请求及 JSON 解析通过。'};
 }catch(error){
  if (!(error instanceof AppError)) throw new AppError('PROBE_FAILED','能力测试未能完成，请重试。',502);
  const unsupported = error.code === 'VISION_UNSUPPORTED' || error.code === 'STRUCTURED_UNSUPPORTED';
  // A timeout, interruption or unavailable upstream gives no new evidence about
  // the selected model's capabilities. Return the cause without changing its record.
  if (!unsupported && !['TEST_FAILED','INVALID_RESULT','PROVIDER_INCOMPATIBLE'].includes(error.code)) throw error;
  return {status:unsupported?'unsupported':'failed',at:new Date().toISOString(),message:error.message};
 }
}
