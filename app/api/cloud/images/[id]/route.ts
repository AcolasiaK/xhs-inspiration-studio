import { isCloudMode } from "@/lib/cloud/mode";
import { cloudError } from "@/lib/cloud/server/config";
import { authLimit,requireUser } from "@/lib/cloud/server/auth";
import { getDataService } from "@/lib/cloud/server/data";
import { AppError } from "@/lib/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{
 if(!isCloudMode())throw new AppError("NOT_FOUND","内容不存在。",404);
 const user=await requireUser(request,{requireIdentity:true});await authLimit(`image_read:${user.id}`,300,60_000);const {id}=await params;
 const image=await (await getDataService()).image(user.id,id,new URL(request.url).searchParams.get("thumbnail")==="1");
 return new Response(new Uint8Array(image.bytes),{headers:{"Content-Type":image.type,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Disposition":"inline"}});
 }catch(error){return cloudError(error);}}
