import { z } from 'zod';
import { personalInputSchema } from './schema';

export const polishScopeSchema=z.enum(['all','body','captions']);
export type PolishScope=z.infer<typeof polishScopeSchema>;
export const polishScopeLabels:Record<PolishScope,string>={all:'全部文案',body:'仅正文',captions:'仅逐图配文'};
export const polishKeySchema=z.string().regex(/^(?:body|title:[0-4]|cover:(?:headline|subline)|caption:[0-9a-f-]{36})$/u);
export const polishFieldSchema=z.object({key:polishKeySchema,text:z.string().max(8000)}).strict();
export type PolishField=z.infer<typeof polishFieldSchema>;
// Keep writing constraints, but omit search data, reference documents and image files.
export const polishInputSchema=personalInputSchema.pick({topic:true,experience:true,requirements:true,coreIntent:true,styles:true,ruleSnapshot:true,customStyle:true,truth:true,bodyLength:true,customLength:true}).strict();
export const polishBasisSchema=z.object({input:polishInputSchema,confirmedPrompt:z.string().trim().min(1).max(12000),keys:z.array(polishKeySchema).min(1).max(17)}).strict();
export const polishRequestSchema=z.object({scope:polishScopeSchema,fields:z.array(polishFieldSchema).min(1).max(17),bases:z.array(polishBasisSchema).min(1).max(16)}).strict().superRefine((v,c)=>{
 const keys=v.fields.map(f=>f.key),mapped=v.bases.flatMap(b=>b.keys);
 const fixed=['title:0','title:1','title:2','title:3','title:4','body','cover:headline','cover:subline'];
 const valid=v.scope==='body'?keys.length===1&&keys[0]==='body':v.scope==='captions'?keys.every(k=>k.startsWith('caption:')):fixed.every((k,i)=>keys[i]===k)&&keys.slice(8).every(k=>k.startsWith('caption:'));
 if(!valid||new Set(keys).size!==keys.length||keys.filter(k=>k.startsWith('caption:')).some(k=>!z.uuid().safeParse(k.slice(8)).success)||mapped.length!==keys.length||new Set(mapped).size!==keys.length||mapped.some(k=>!keys.includes(k)))c.addIssue({code:'custom',message:'润色范围或图片对应关系无效，原文保留。'});
 if(!v.fields.some(f=>f.text.trim()))c.addIssue({code:'custom',message:'当前范围没有可润色的文案。'});
 if(v.bases.some(b=>b.input.styles.length!==1))c.addIssue({code:'custom',message:'这份旧稿使用多个风格，请先明确单一风格并确认重写依据，再润色。'});
});
export type PolishRequest=z.infer<typeof polishRequestSchema>;
export const polishOutputSchema=z.object({fields:z.array(polishFieldSchema).min(1).max(17)}).strict();
export const humanizerVersionSchema=z.object({revision:z.string().max(30),commit:z.string().regex(/^[a-f0-9]{40}$/u),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const polishResponseSchema=polishOutputSchema.extend({model:z.string().min(1).max(200),humanizer:humanizerVersionSchema});
export type PolishResponse=z.infer<typeof polishResponseSchema>;
export const polishUndoSchema=z.object({scope:polishScopeSchema,before:z.array(polishFieldSchema).max(17),after:z.array(polishFieldSchema).max(17),identity:z.string().max(160000),basisKey:z.string().max(1000000),at:z.string().datetime(),model:z.string().max(200),humanizer:humanizerVersionSchema});
export type PolishUndo=z.infer<typeof polishUndoSchema>;
