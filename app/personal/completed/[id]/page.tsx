import { notFound } from 'next/navigation';
import { z } from 'zod';
import { CompletedLibrary } from '@/components/personal/completed-library';
import { isCloudMode } from '@/lib/cloud/mode';
import { requirePageUser } from '@/lib/cloud/server/auth';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{id:string}>}){if(isCloudMode())await requirePageUser();const {id}=await params;if(!z.string().uuid().safeParse(id).success)notFound();return <CompletedLibrary key={id} noteId={id}/>;}
