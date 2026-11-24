import { z } from 'zod';
const date = z.string().max(64).refine(value=>Number.isFinite(Date.parse(value)));
const score=z.number().finite().min(0).max(100);
const editorialSchema=z.object({
  version:z.literal(1),directions:z.array(z.enum(['travel','daily','emotion'])).min(1).max(3),kind:z.enum(['discussion','seasonal']),fit:z.enum(['direct','extended']).optional(),facets:z.array(z.string().max(40)).max(24).optional(),
  reason:z.string().max(400),angles:z.array(z.string().max(300)).min(1).max(2),verification:z.string().max(300),
  evidence:z.array(z.string().max(180)).max(3),score:z.object({relevance:score,experience:score,timeliness:score,seasonal:score,verifiability:score,sourceRank:score}),
});
export const cachedHotspotSchema=z.object({id:z.string().max(64),title:z.string().max(180),description:z.string().max(1200),url:z.url().max(2048).refine(value=>value.startsWith('https://')),source:z.string().max(120),publishedAt:date.nullable(),collectedAt:date,rank:z.number().int().positive(),editorial:editorialSchema.optional().catch(undefined)});
