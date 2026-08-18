import { NextResponse } from 'next/server';
import { callGas } from '@/lib/gas';
import { endSession, hasSession, startSession, verifyPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: '잘못된 요청입니다.' }, { status: 400 });
  }

  const action = String(body.action ?? '');

  try {
    if (action === 'login') {
      if (!verifyPassword('gate', String(body.password ?? ''))) {
        return NextResponse.json({ ok: false, message: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
      }
      await startSession('gate');
      return NextResponse.json({ ok: true });
    }

    if (action === 'logout') {
      await endSession('gate');
      return NextResponse.json({ ok: true });
    }

    if (action === 'session') {
      return NextResponse.json({ ok: true, authed: await hasSession('gate') });
    }

    if (!(await hasSession('gate'))) {
      return NextResponse.json({ ok: false, message: '로그인이 필요합니다.' }, { status: 401 });
    }

    if (action === 'status') {
      return NextResponse.json(await callGas('gate.status'), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (action === 'set') {
      return NextResponse.json(await callGas('gate.set', { blocked: !!body.blocked }), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.json({ ok: false, message: '알 수 없는 요청입니다.' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, message: (err as Error).message }, { status: 502 });
  }
}
