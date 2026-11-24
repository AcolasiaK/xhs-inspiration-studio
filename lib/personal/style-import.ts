import { emptyRuleContent, type RuleSection } from './style-rules';

/** Deterministic text organization only. No model, network, scripts or tools run. */
export function organizeWritingSkill(text:string, filename='粘贴的 Skill') {
  if(!text.trim()||text.length>64000)throw new Error('请提供 1～64000 字符的 SKILL.md 文本。');
  const warnings:string[]=['导入仅整理为新风格草稿；请检查所有栏目和只读约束，试生成后再启用。'];
  const front=text.match(/^---\s*\n([\s\S]*?)\n---/), name=front?.[1].match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim();
  const content=emptyRuleContent((name||filename.replace(/\.md$/i,'')||'导入风格').slice(0,60));
  const dependencies=[...new Set((text.match(/(?:\.?\.?\/)?[\w\-/]+\.(?:md|txt|json|ya?ml|py|js|sh)\b/gi)||[]).filter(v=>!/^SKILL\.md$/i.test(v)))].slice(0,30);
  if(dependencies.length)warnings.push('检测到配套文件引用，尚未取得这些文件；未加载示例或执行依赖。');
  if(/https?:\/\/|搜索|检索|联网|browse|web_search|fetch\(/i.test(text))warnings.push('检测到联网或搜索依赖：导入不会新增搜索、资料核查或书摘原文核验能力。');
  if(/```|\b(?:bash|exec|python|npm|curl|run_command)\b|执行.{0,8}(?:脚本|命令)/i.test(text))warnings.push('脚本、命令和代码块不执行，代码块未纳入写作规则；原文可查看。');
  if(/小标题|headline|多选|融合.{0,8}风格|主辅|系统指令|权限|API.?Key|密钥/i.test(text))warnings.push('检测到可能冲突的格式或系统要求：单选、逐图无小标题、账号权限和密钥处理等共同约束优先。');
  let section:RuleSection='overall';
  const source=text.replace(/^---\s*\n[\s\S]*?\n---\s*/,'').replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g,'');
  for(const line of source.split('\n')){
    const heading=line.match(/^#{1,6}\s+(.+)/)?.[1];
    if(heading){section=/逐图|配文|caption/i.test(heading)?'captions':/标题|title/i.test(heading)?'title':/正文|body/i.test(heading)?'body':/避免|禁止|不要|avoid/i.test(heading)?'avoid':'overall';}
    content.sections[section]+=(content.sections[section]?'\n':'')+line;
  }
  for(const key of Object.keys(content.sections) as RuleSection[])content.sections[key]=content.sections[key].trim();
  return {content,review:{sourceName:filename.slice(0,160),warnings,dependencies,originalText:text}};
}
