import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * 두 개의 독립된 자물쇠를 쓴다.
 *
 * admin — 회차 설정용. 운영자에게 알려주는 비밀번호.
 * gate  — 사이트 차단용. 개발자만 갖는다. 관리자 비밀번호가 넘어간 뒤에도
 *         사이트를 내리고 올리는 권한은 분리되어 있어야 한다.
 */
export type Realm = 'admin' | 'gate';

const COOKIE: Record<Realm, string> = { admin: 'pb_admin', gate: 'pb_gate' };
const MAX_AGE = 60 * 60 * 12; // 12시간

function secret() {
  const s = process.env.ADMIN_COOKIE_SECRET;
  if (!s) throw new Error('ADMIN_COOKIE_SECRET 환경변수가 설정되지 않았습니다.');
  return s;
}

function passwordOf(realm: Realm) {
  const key = realm === 'admin' ? 'ADMIN_PASSWORD' : 'GATE_PASSWORD';
  const p = process.env[key];
  if (!p) throw new Error(`${key} 환경변수가 설정되지 않았습니다.`);
  return p;
}

/** 비밀번호 자체가 아니라 서명값을 쿠키에 담는다. */
function sessionToken(realm: Realm) {
  return createHmac('sha256', secret()).update(`${realm}:${passwordOf(realm)}`).digest('hex');
}

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyPassword(realm: Realm, input: string) {
  return safeEqual(String(input ?? ''), passwordOf(realm));
}

export async function startSession(realm: Realm) {
  const jar = await cookies();
  jar.set(COOKIE[realm], sessionToken(realm), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function endSession(realm: Realm) {
  const jar = await cookies();
  jar.delete(COOKIE[realm]);
}

export async function hasSession(realm: Realm) {
  const jar = await cookies();
  const got = jar.get(COOKIE[realm])?.value;
  if (!got) return false;
  try {
    return safeEqual(got, sessionToken(realm));
  } catch {
    return false;
  }
}
