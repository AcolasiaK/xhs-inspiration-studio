import { redirect } from "next/navigation";
import { isCloudMode } from "@/lib/cloud/mode";
import { getPageAuthState } from "@/lib/cloud/server/auth";
import { SetupScreen } from "@/components/cloud/auth-screens";
export const dynamic = "force-dynamic";
export default async function Page(){if(!isCloudMode())redirect("/");const state=await getPageAuthState();if(!state.gateVerified)redirect("/entry");if(state.bootstrapComplete)redirect("/entry");return <SetupScreen/>;}
