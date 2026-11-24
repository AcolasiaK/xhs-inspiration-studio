/** A search query is public subject matter, never a full diary, URL or credential. */
export function safePersonalSearchQuery(value: string): string {
  const query = value.trim().normalize("NFKC").replace(/[，,、;；]/gu, " ").replace(/\s+/gu, " ");
  if (!query || query.length > 100 || /[\r\n]/u.test(value)) return "";
  if (/https?:|www\.|@|[<>]|(?:\d[ -]?){11,}|\b(?:sk-|bearer|token|cookie)\b|密码|口令|密钥|验证码/iu.test(query)) return "";
  return query;
}

/** Keep public place names separate from the guide intent added by each search provider. */
export function personalGuidePlaces(value: string): string[] {
  const terms = safePersonalSearchQuery(value).split(" ");
  const places = terms.flatMap(term => {
    if (!term || /^(?:行程|路线|(?:旅游|旅行|游玩|出行|交通)?攻略)$/u.test(term)) return [];
    const name = term.replace(/(?:旅游|旅行|游玩|出行|交通)?攻略$/u, "");
    return [name.length >= 2 ? name : term];
  });
  return [...new Set(places)];
}

/** Reject a model that copies the diary instead of extracting public keywords. */
export function safeDerivedPersonalSearchQuery(value: string, experience: string): string {
  const query=safePersonalSearchQuery(value);
  const compact=(s:string)=>s.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu,"").toLowerCase();
  const queryKey=compact(query), experienceKey=compact(experience);
  if(!query || query.length>70 || query.split(" ").some(term=>term.length>20) || query.split(" ").length>5) return "";
  if(queryKey===experienceKey || (queryKey.length>20 && experienceKey.includes(queryKey))) return "";
  if(/我们|我的|本人|今天我|昨天我|我去了|我遇到|朋友叫|手机号|住址/u.test(query)) return "";
  return query;
}

export const personalQueryInstruction = `另外返回 searchQuery：仅从用户实际输入的主题、检索地点及经历中提取 2～5 个适合查询公开背景的关键词，用空格分隔，总长不超过 100 字；明确地点或具体实体放最前。不要推测用户未说的目的地，不采用创意虚构情节当查询事实。
只保留公开地点、景点、事物或背景主题，不包含私人姓名、电话、住址、账户、个人故事、情绪细节或完整经历，不复制输入全文。用户已填检索词时尊重该选择。完全无法确定可检索的公开主题时返回空字符串。
当前尚未搜索，不能声称资料已查到，也不能在提示词里填写未经核实的票价、营业时间或出处；实际检索资料会在本次请求后续附加。`;
