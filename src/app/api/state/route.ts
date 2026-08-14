import { NextResponse } from 'next/server';
import { callGas } from '@/lib/gas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const light = new URL(req.url).searchParams.get('light') === '1';
  try {
    const data = await callGas(light ? 'taken' : 'state');
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error).message },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
