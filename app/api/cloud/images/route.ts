import { isCloudMode } from "@/lib/cloud/mode";
import { assertOrigin,cloudError } from "@/lib/cloud/server/config";
import { authLimit,requireUser } from "@/lib/cloud/server/auth";
import { getDataService } from "@/lib/cloud/server/data";
import { AppError } from "@/lib/errors";
import { MAX_FILE_BYTES } from "@/lib/constants";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{
 if(!isCloudMode())throw new AppError("NOT_FOUND","内容不存在。",404);
 assertOrigin(request);const user=await requireUser(request,{requireIdentity:true});await authLimit(`image_upload:${user.id}`,36,60_000);
 const type=request.headers.get("content-type")||"",limit=MAX_FILE_BYTES+128*1024;
 if(!type.startsWith("multipart/form-data;"))throw new AppError("INVALID_FORM","请上传图片。",415);
 if(Number(request.headers.get("content-length"))>limit)throw new AppError("TOO_LARGE","图片不能超过 5MB。",413);
 const reader=request.body?.getReader();if(!reader)throw new AppError("INVALID_FORM","没有收到图片。",400);const parts:Uint8Array[]=[];let size=0;
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader.cancel();throw new AppError("TOO_LARGE","图片不能超过 5MB。",413);}parts.push(chunk.value);}}finally{reader.releaseLock();}
 let form:FormData;try{form=await new Response(Buffer.concat(parts),{headers:{"content-type":type}}).formData();}catch{throw new AppError("INVALID_FORM","图片上传格式不正确。",400);}
 if(form.getAll("image").length!==1)throw new AppError("INVALID_FORM","每次只能保存一张图片。",400);
 const file=form.get("image");if(!(file instanceof File))throw new AppError("INVALID_FORM","没有收到有效图片。",400);
 const result=await (await getDataService()).upload(user.id,form.get("id"),file);return Response.json(result,{headers:{"Cache-Control":"private, no-store"}});
 }catch(error){return cloudError(error);}}
