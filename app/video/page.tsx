import { VideoStudio } from "@/components/video/studio";
import { getPublicConfig } from "@/lib/server/config";
import { isCloudMode } from "@/lib/cloud/mode";
import { requirePageUser } from "@/lib/cloud/server/auth";
export const dynamic="force-dynamic";
export default async function Page(){if(isCloudMode())await requirePageUser();return <VideoStudio config={getPublicConfig()} timeoutMs={195_000}/>;}
