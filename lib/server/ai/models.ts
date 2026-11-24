import 'server-only';
import { modelListInput } from '@/lib/ai-config';
import { AppError } from '@/lib/errors';
import { normalizeBaseUrl } from './address';
import { listProviderModels } from './provider';
import { readStateFor } from './store';

/** Preview current form connection without saving it or consulting the default. */
export async function queryProfileModels(owner:string,raw:unknown,id?:string,revision?:string,signal?:AbortSignal){
 const old=id?(await readStateFor(owner)).profiles.find(profile=>profile.id===id):undefined;
 if(id&&!old)throw new AppError('NOT_FOUND','配置不存在或不属于当前账号。',404);
 if(old&&revision&&old.revision!==revision)throw new AppError('CONFLICT','配置已在其他页面修改，请重新打开后获取模型列表。',409);
 const source=raw===undefined&&old?{
  provider:old.provider,baseUrl:old.baseUrl,apiKey:'',protocol:old.protocol,timeoutSeconds:old.timeoutSeconds,
 }:raw;
 const parsed=modelListInput.safeParse(source);
 if(!parsed.success)throw new AppError('INVALID_FORM','请检查服务类型、API 基础地址和密钥；获取列表无需填写模型 ID。',400);
 const input=parsed.data,baseUrl=normalizeBaseUrl(input.baseUrl,input.provider);
 const changed=old&&(baseUrl!==old.baseUrl||input.provider!==old.provider);
 if(changed&&!input.apiKey&&!input.clearApiKey)throw new AppError('KEY_REQUIRED','更换地址或服务类型时请重新填写属于该服务的密钥，避免误发原密钥。',400);
 const apiKey=input.clearApiKey?'':input.apiKey||old?.apiKey||'';
 return listProviderModels({provider:input.provider,baseUrl,apiKey,timeoutSeconds:input.timeoutSeconds},signal);
}
