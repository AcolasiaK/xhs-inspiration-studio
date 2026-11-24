import { AiSettings } from '@/components/ai/settings';
import { isCloudMode } from '@/lib/cloud/mode';
import { requirePageUser } from '@/lib/cloud/server/auth';
export default async function Page(){if(isCloudMode())await requirePageUser();return <AiSettings/>;}
