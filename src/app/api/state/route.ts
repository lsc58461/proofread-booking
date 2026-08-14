import { NextResponse } from 'next/server';
import { callGas } from '@/lib/gas';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 잔여석 조회는 접속자 수만큼 반복해서 들어온다. 150명이 5초마다 물어보면
 * 초당 30건인데 Apps Script 는 동시 실행 30개가 한계라 그것만으로 포화된다.
 * 그래서 잠깐 캐시해 두고, 캐시가 비었을 때도 한 번만 조회하도록 묶는다.
 */
const TAKEN_TTL = 2000;

type Cached = { at: number; body: Record<string, unknown> };
let cached: Cached | null = null;
let inflight: Promise<Record<string, unknown>> | null = null;

async function getTaken() {
  const now = Date.now();
  if (cached && now - cached.at < TAKEN_TTL) return cached.body;

  // 캐시가 만료된 순간 요청이 몰려도 Apps Script 호출은 한 번만 나가게 한다.
  if (!inflight) {
    inflight = callGas<Record<string, unknown>>('taken')
      .then((data) => {
        cached = { at: Date.now(), body: data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function GET(req: Request) {
  const light = new URL(req.url).searchParams.get('light') === '1';
  try {
    if (!light) {
      const data = await callGas('state');
      return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    const body = await getTaken();
    // 캐시된 응답을 쓰더라도 시계 보정에 쓰이는 값은 현재 시각으로 맞춘다.
    return NextResponse.json(
      { ...body, now: Date.now() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: (err as Error).message },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
