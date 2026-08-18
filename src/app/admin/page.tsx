import { notFound } from 'next/navigation';
import { isBlocked } from '@/lib/blocked';
import AdminClient from '@/components/AdminClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  if (await isBlocked()) notFound();
  return <AdminClient />;
}
