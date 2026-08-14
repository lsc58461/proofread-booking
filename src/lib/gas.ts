import 'server-only';

/**
 * Apps Script 웹앱 호출.
 *
 * 브라우저에서 직접 부르지 않고 항상 서버를 거친다. Apps Script 웹앱은
 * 302 리다이렉트 + CORS 프리플라이트 미지원이라 브라우저에서 다루기 번거롭고,
 * 서버 경유로 두면 GAS_URL 과 토큰이 클라이언트에 노출되지 않는다.
 */
const MAX_TRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callGas<T>(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const url = process.env.GAS_URL;
  const token = process.env.GAS_TOKEN;
  if (!url || !token) {
    throw new Error('GAS_URL / GAS_TOKEN 환경변수가 설정되지 않았습니다.');
  }

  const body = JSON.stringify({ token, action, ...extra });
  let lastError = '';

  // 동시 접속이 몰리면 Apps Script 가 실행 한도에 걸려 JSON 대신 오류 페이지를 준다.
  // 같은 신청을 다시 보내도 같은 결과가 나오도록 서버가 처리하므로 재시도해도 안전하다.
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        // application/json 으로 보내면 Apps Script 가 프리플라이트를 요구하는 경우가 있어
        // 단순 요청으로 취급되는 text/plain 을 쓴다. e.postData.contents 는 동일하게 읽힌다.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow',
        cache: 'no-store',
      });

      const text = await res.text();
      try {
        const data = JSON.parse(text) as T & { retryable?: boolean; message?: string };
        // 락 경합처럼 잠시 뒤 다시 보내면 풀리는 실패는 여기서 흡수한다.
        // 같은 신청을 다시 보내도 결과가 같도록 서버가 처리하므로 안전하다.
        if (data.retryable && attempt < MAX_TRIES) {
          lastError = data.message ?? '접속이 몰리고 있습니다.';
          await sleep(400 * attempt + Math.floor(Math.random() * 300));
          continue;
        }
        return data as T;
      } catch {
        lastError = res.ok
          ? 'Apps Script 가 JSON 이 아닌 응답을 돌려줬습니다. 접속이 몰렸거나, 웹앱 배포의 "액세스 권한"이 "모든 사용자"가 아닐 수 있습니다.'
          : `Apps Script 응답 오류 (${res.status})`;
      }
    } catch (err) {
      lastError = `Apps Script 에 연결하지 못했습니다: ${(err as Error).message}`;
    }

    if (attempt < MAX_TRIES) await sleep(300 * attempt);
  }

  throw new Error(lastError);
}
