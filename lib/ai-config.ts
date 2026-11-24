import { z } from "zod";
// Model limits are enforced by the selected service, not a fixed application ceiling.
export const outputTokenLimitSchema = z.number().int().min(256);
export const profileInput = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.enum(["openai", "deepseek", "custom"]),
  protocol: z.enum(["responses", "chat-completions"]),
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(160).regex(/^[\w.\-/:]+$/),
  apiKey: z.string().trim().max(4096).default(""),
  clearApiKey: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(10).max(180).default(120),
  maxOutputTokens: outputTokenLimitSchema.default(8000),
  jsonMode: z.enum(["schema", "object"]).default("schema"),
}).strict();
// Listing models needs connection details only; saving still requires a model ID.
export const modelListInput = profileInput.pick({
  provider: true, baseUrl: true, apiKey: true, clearApiKey: true,
  protocol: true, timeoutSeconds: true,
}).extend({ protocol: profileInput.shape.protocol.optional() });
export type ModelListInput = z.infer<typeof modelListInput>;
export type ProfileInput = z.infer<typeof profileInput>;
export type Probe = { status: "unverified" | "passed" | "failed" | "unsupported"; at: string | null; message: string };
export type Profile = Omit<ProfileInput,"clearApiKey"> & { id: string; revision: string; textTest: Probe; imageTest: Probe };
export type PublicProfile = Omit<Profile,"apiKey"> & { hasApiKey: boolean; maskedApiKey: string };
export type ProfileList = { profiles: PublicProfile[]; defaultId: string | null; account: string };
export const unverified = (): Probe => ({status:"unverified",at:null,message:"尚未验证"});
export const presets = { openai:{baseUrl:"https://api.openai.com/v1",protocol:"responses",jsonMode:"schema"},deepseek:{baseUrl:"https://api.deepseek.com",protocol:"chat-completions",jsonMode:"object"},custom:{baseUrl:"",protocol:"chat-completions",jsonMode:"object"} } as const;
