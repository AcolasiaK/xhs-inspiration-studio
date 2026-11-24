import { z } from 'zod';
import { ownerFor } from '@/lib/server/ai/selection';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { AppError } from '@/lib/errors';
import { checkRateLimit } from '@/lib/server/guard';
import { emptyRuleContent, ruleContentSchema, styleIdSchema } from '@/lib/personal/style-rules';
import { listPersonalStyles, createPersonalStyle, savePersonalStyle, activatePersonalStyle, deactivatePersonalStyle, deletePersonalStyle, restorePersonalStyle, copyPersonalStyle, importPersonalStyle } from '@/lib/server/personal-style-store';
export const runtime='nodejs';
const schema=z.object({action:z.enum(['create','save','activate','deactivate','delete','restore','copy','import']),id:styleIdSchema.optional(),revision:z.number().int().nonnegative().optional(),versionId:z.string().max(100).optional(),content:z.unknown().optional(),text:z.string().max(64000).optional(),filename:z.string().max(160).optional()}).strict();
const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request){try{return json(await listPersonalStyles(await ownerFor(request)));}catch(e){return cloudError(e);}}
export async function POST(request:Request){try{
  const owner=await ownerFor(request);checkRateLimit('personal-style-settings:'+owner,60);
  const parsed=schema.safeParse(await readJson(request,160000));if(!parsed.success)throw new AppError('INVALID_FORM','请检查风格设置内容与长度。',400);const v=parsed.data;
  if(v.action==='create'){
    const content=ruleContentSchema.safeParse(v.content??emptyRuleContent());
    if(!content.success)throw new AppError('INVALID_FORM','请检查新风格名称、规则与长度。',400);
    return json({style:await createPersonalStyle(owner,content.data)});
  }
  if(v.action==='import'){if(!v.text?.trim())throw new AppError('INVALID_FORM','请粘贴或上传 SKILL.md。',400);return json({style:await importPersonalStyle(owner,v.text,v.filename)});}
  if(!v.id)throw new AppError('INVALID_FORM','请选择风格。',400);
  if(v.action==='copy'&&v.versionId)return json({style:await copyPersonalStyle(owner,v.id,v.versionId)});
  if(v.revision===undefined)throw new AppError('INVALID_FORM','请重新读取风格版本。',400);
  if(v.action==='save')return json({style:await savePersonalStyle(owner,v.id,v.revision,v.content)});
  if(v.action==='deactivate')return json({style:await deactivatePersonalStyle(owner,v.id,v.revision)});
  if(v.action==='delete'){
    await deletePersonalStyle(owner,v.id,v.revision);
    return json({style:null});
  }
  if(!v.versionId)throw new AppError('INVALID_FORM','请选择规则版本。',400);
  if(v.action==='activate')return json({style:await activatePersonalStyle(owner,v.id,v.revision,v.versionId)});
  if(v.action==='restore')return json({style:await restorePersonalStyle(owner,v.id,v.revision,v.versionId)});
  throw new AppError('INVALID_FORM','此风格操作不受支持。',400);
}catch(e){return cloudError(e);}}
