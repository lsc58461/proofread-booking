import { NextResponse } from 'next/server';
import { callGas } from '@/lib/gas';
import { endAdminSession, isAdmin, startAdminSession, verifyPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Apps Script 로 그대로 넘겨도 되는 동작만 통과시킨다. */
const FORWARDABLE = new Set([
  'admin.load',
  'admin.inspect',
  'admin.preview',
  'admin.save',
  'admin.claims',
  'admin.delete',
  'admin.sync',
  'admin.import',
  'admin.reset',
  'admin.refresh',
  'admin.bench',
]);

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
      if (!verifyPassword(String(body.password ?? ''))) {
        return NextResponse.json({ ok: false, message: '비밀번호가 올바르지 않습니다.' }, { status: 401 });
      }
      await startAdminSession();
      return NextResponse.json({ ok: true });
    }

    if (action === 'logout') {
      await endAdminSession();
      return NextResponse.json({ ok: true });
    }

    if (action === 'session') {
      return NextResponse.json({ ok: true, authed: await isAdmin() });
    }

    if (!FORWARDABLE.has(action)) {
      return NextResponse.json({ ok: false, message: '알 수 없는 요청입니다.' }, { status: 400 });
    }

    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, message: '로그인이 필요합니다.' }, { status: 401 });
    }

    const { action: _drop, password: _pw, ...rest } = body;
    void _drop;
    void _pw;
    const data = await callGas(action, rest);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ ok: false, message: (err as Error).message }, { status: 502 });
  }
}
