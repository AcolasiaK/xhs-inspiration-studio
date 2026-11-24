import { mkdir, writeFile } from 'node:fs/promises';
import { BUILTIN_PERSONAL_STYLES, builtinRuleSnapshot, fullRulePackage } from '../lib/personal/style-rules';
async function main(){
await mkdir('docs',{recursive:true});
await writeFile('docs/personal-style-defaults.md',`# 个人创作：四个初始规则包\n\n由实际运行的规则数据与只读共同约束生成，未使用模型改写。页面中的完整规则预览调用同一个 fullRulePackage。此文档记录内置 v1；账号后续编辑以管理页保存版本为准。\n\n栏目为空表示沿用整体表达与共同规则。原有 styleWriting 段落用于所有个人创作调用，因此放入整体表达；各栏目的新增规则仅作用于对应栏目。没有用户认可的范文，四套示例均为空。\n\n来源与迁移说明见 [迁移记录](./personal-style-migration.md)。\n\n${BUILTIN_PERSONAL_STYLES.map(id=>fullRulePackage(builtinRuleSnapshot(id))).join('\n\n---\n\n')}\n`);

}
void main();
