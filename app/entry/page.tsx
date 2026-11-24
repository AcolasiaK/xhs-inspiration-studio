import { redirect } from "next/navigation";
import { isCloudMode } from "@/lib/cloud/mode";
import { pageAuthForDisplay } from "@/lib/cloud/server/page-auth-display";
import { EntryScreen } from "@/components/cloud/auth-screens";
export const dynamic = "force-dynamic";
export default async function Page({searchParams}:{searchParams:Promise<{changed?:string;gateChanged?:string}>}){if(!isCloudMode())redirect("/");const {state,configurationError}=await pageAuthForDisplay();if(state.user)redirect(state.user.mustChange?"/account":"/");const query=await searchParams;return <EntryScreen state={state} passwordChanged={query.changed==="1"} gateChanged={query.gateChanged==="1"} initialGateError={configurationError?"服务端访问配置暂不可用，请联系管理员检查。":""}/>;}
