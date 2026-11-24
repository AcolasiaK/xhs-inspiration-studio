import { z } from "zod";
import { isCloudMode } from "@/lib/cloud/mode";
import { assertOrigin, cloudError, readJson, MAX_CLOUD_DATA_BYTES } from "@/lib/cloud/server/config";
import { authLimit,requireUser } from "@/lib/cloud/server/auth";
import { getDataService } from "@/lib/cloud/server/data";
import { ConcurrencyGate } from "@/lib/cloud/server/concurrency";
import { AppError } from "@/lib/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const saveConcurrency=new ConcurrencyGate(4,2);
const id=z.string().uuid(), expected=z.number().int().nonnegative().nullable();
const action=z.discriminatedUnion("action",[
 z.object({action:z.literal("personal-complete"),note:z.unknown()}).strict(),
 z.object({action:z.literal("personal-ensure"),draft:z.unknown()}).strict(),
 z.object({action:z.literal("photo-write"),draft:z.unknown(),expected,active:z.boolean()}).strict(),
 z.object({action:z.literal("photo-remove"),id}).strict(),z.object({action:z.literal("photo-active"),id}).strict(),
 z.object({action:z.literal("video-write"),draft:z.unknown(),expected,active:z.boolean()}).strict(),
 z.object({action:z.literal("video-remove"),id}).strict(),z.object({action:z.literal("video-active"),id}).strict(),
 z.object({action:z.literal("personal-write"),draft:z.unknown(),expected,active:z.boolean()}).strict(),
 z.object({action:z.literal("personal-remove"),id}).strict(),z.object({action:z.literal("personal-active"),id}).strict(),
 z.object({action:z.literal("template-write"),template:z.unknown()}).strict(),z.object({action:z.literal("template-remove"),id}).strict(),
]);
function requireMode(){if(!isCloudMode())throw new AppError("NOT_FOUND","内容不存在。",404);}
export async function GET(request:Request){try{
 requireMode();const user=await requireUser(request,{requireIdentity:true});await authLimit(`data_read:${user.id}`,600,60_000);const data=await getDataService();const url=new URL(request.url),kind=url.searchParams.get("kind");
 if(kind==="photo-workspace")return Response.json(await data.photoWorkspace(user.id),{headers});
 if(kind==="photo")return Response.json(await data.photo(user.id,url.searchParams.get("id")),{headers});
 if(kind==="video-workspace")return Response.json(await data.videos(user.id),{headers});
 if(kind==="video")return Response.json(await data.video(user.id,url.searchParams.get("id")),{headers});
 if(kind==="personal-completed-list")return Response.json(await data.completedList(user.id),{headers});
 if(kind==="personal-completed")return Response.json(await data.completed(user.id,url.searchParams.get("id")),{headers});
 if(kind==="personal-workspace")return Response.json(await data.personalWorkspace(user.id),{headers});
 if(kind==="personal")return Response.json(await data.personal(user.id,url.searchParams.get("id")),{headers});
 if(kind==="templates")return Response.json(await data.templates(user.id),{headers});
 throw new AppError("INVALID_FORM","请检查读取方式。",400);
 }catch(error){return cloudError(error);}}
export async function POST(request:Request){let release:(()=>void)|undefined;try{
 requireMode();assertOrigin(request);const user=await requireUser(request,{requireIdentity:true});release=saveConcurrency.enter(user.id);await authLimit(`data_write:${user.id}`,120,60_000);const input=action.safeParse(await readJson(request,MAX_CLOUD_DATA_BYTES));if(!input.success)throw new AppError("INVALID_FORM","请检查提交的草稿内容。",400);
 const data=await getDataService(),v=input.data;let result:unknown={ok:true};
 switch(v.action){
  case "personal-complete":result=await data.saveCompleted(user.id,v.note);break;
  case "personal-ensure":result=await data.ensurePersonal(user.id,v.draft);break;
  case "photo-write":result=await data.savePhoto(user.id,v.draft,v.expected,v.active);break;
  case "photo-remove":await data.deletePhoto(user.id,v.id);break;
  case "photo-active":await data.setActive(user.id,"photo",v.id);break;
  case "video-write":result=await data.saveVideo(user.id,v.draft,v.expected,v.active);break;
  case "video-remove":await data.deleteVideo(user.id,v.id);break;
  case "video-active":await data.setActive(user.id,"video",v.id);break;
  case "personal-write":result=await data.savePersonal(user.id,v.draft,v.expected,v.active);break;
  case "personal-remove":await data.deletePersonal(user.id,v.id);break;
  case "personal-active":await data.setPersonalActive(user.id,v.id);break;
  case "template-write":result=await data.saveTemplate(user.id,v.template);break;
  case "template-remove":await data.deleteTemplate(user.id,v.id);break;
 }
 return Response.json(result,{headers});
 }catch(error){return cloudError(error);}finally{release?.();}}
