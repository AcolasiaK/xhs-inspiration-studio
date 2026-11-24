import { PersonalStudio } from "@/components/personal/studio";
import { getPublicConfig } from "@/lib/server/config";
import { isCloudMode } from "@/lib/cloud/mode";
import { requirePageUser } from "@/lib/cloud/server/auth";

export const dynamic = "force-dynamic";
export default async function Page() {
  if (isCloudMode()) await requirePageUser();
  return <PersonalStudio config={getPublicConfig()} />;
}
