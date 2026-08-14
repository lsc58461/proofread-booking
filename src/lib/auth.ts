import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const ADMIN_COOKIE = 'pb_admin';
const MAX_AGE = 60 * 60 * 12; // 12시간

function secret() {
  const s = process.env.ADMIN_COOKIE_SECRET;
  if (!s) throw new Error('ADMIN_COOKIE_SECRET 환경변수가 설정되지 않았습니다.');
  return s;
}

function adminPassword() {
  const p = process.env.ADMIN_PASSWORD;
  if (!p) throw new Error('ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.');
  return p;
}

/** 비밀번호 자체가 아니라 서명값을 쿠키에 담는다. */
function sessionToken() {
  return createHmac('sha256', secret()).update(adminPassword()).digest('hex');
}

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyPassword(input: string) {
  return safeEqual(String(input ?? ''), adminPassword());
}

export async function startAdminSession() {
  const jar = await cookies();
  jar.set(ADMIN_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function endAdminSession() {
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE);
}

export async function isAdmin() {
  const jar = await cookies();
  const got = jar.get(ADMIN_COOKIE)?.value;
  if (!got) return false;
  try {
    return safeEqual(got, sessionToken());
  } catch {
    return false;
  }
}
