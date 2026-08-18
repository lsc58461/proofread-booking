import { notFound } from 'next/navigation';
import { isBlocked } from '@/lib/blocked';
import ApplyClient from '@/components/ApplyClient';

// 차단 여부를 렌더 전에 판정해야 원래 화면이 잠깐 보였다 사라지는 일이 없다.
export const dynamic = 'force-dynamic';

export default async function Page() {
  if (await isBlocked()) notFound();
  return <ApplyClient />;
}
