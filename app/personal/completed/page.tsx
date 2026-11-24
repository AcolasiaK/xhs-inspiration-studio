import { CompletedLibrary } from '@/components/personal/completed-library';
import { isCloudMode } from '@/lib/cloud/mode';
import { requirePageUser } from '@/lib/cloud/server/auth';
export const dynamic='force-dynamic';
export default async function Page(){if(isCloudMode())await requirePageUser();return <CompletedLibrary/>;}
