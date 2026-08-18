import 'server-only';
import { callGas } from './gas';

/**
 * 차단 여부를 화면 렌더 전에 서버에서 판정하기 위한 조회.
 *
 * 클라이언트에서 확인하면 원래 화면이 잠깐 보였다가 404 로 바뀌어 "없는
 * 페이지"로 보이지 않는다. 다만 접속 때마다 Apps Script 를 부르면 앞서
 * 줄여둔 부하가 다시 늘어나므로, 짧게 캐시하고 동시 요청은 한 번만 나가게 묶는다.
 */
const TTL = 5000;

let cached: { at: number; blocked: boolean } | null = null;
let inflight: Promise<boolean> | null = null;

export async function isBlocked(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < TTL) return cached.blocked;

  if (!inflight) {
    inflight = callGas<{ ok: boolean; blocked?: boolean }>('gate.status')
      .then((r) => {
        const blocked = !!r.blocked;
        cached = { at: Date.now(), blocked };
        return blocked;
      })
      .catch(() => {
        // 조회에 실패했다고 사이트를 막아버리면 장애가 두 배가 된다.
        // 직전에 알던 값이 있으면 그것을, 없으면 정상으로 본다.
        return cached?.blocked ?? false;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
