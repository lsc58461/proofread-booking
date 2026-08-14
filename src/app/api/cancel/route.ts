import { NextResponse } from 'next/server';
import { callGas } from '@/lib/gas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: { name?: string; last4?: string; slot?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: '잘못된 요청입니다.' }, { status: 400 });
  }

  try {
    const data = await callGas('cancel', {
      payload: {
        name: body.name ?? '',
        last4: body.last4 ?? '',
        slot: body.slot ?? '',
      },
    });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error).message },
      { status: 502 },
    );
  }
}
