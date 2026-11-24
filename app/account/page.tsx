import { redirect } from "next/navigation";
import { isCloudMode } from "@/lib/cloud/mode";
import { requirePageUser } from "@/lib/cloud/server/auth";
import { AccountScreen } from "@/components/cloud/auth-screens";
export const dynamic = "force-dynamic";
export default async function Page(){if(!isCloudMode())redirect("/");const user=await requirePageUser({allowPasswordChange:true});return <AccountScreen user={user}/>;}
