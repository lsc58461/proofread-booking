import 'server-only';

/**
 * Apps Script 웹앱 호출.
 *
 * 브라우저에서 직접 부르지 않고 항상 서버를 거친다. Apps Script 웹앱은
 * 302 리다이렉트 + CORS 프리플라이트 미지원이라 브라우저에서 다루기 번거롭고,
 * 서버 경유로 두면 GAS_URL 과 토큰이 클라이언트에 노출되지 않는다.
 */
export async function callGas<T>(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const url = process.env.GAS_URL;
  const token = process.env.GAS_TOKEN;
  if (!url || !token) {
    throw new Error('GAS_URL / GAS_TOKEN 환경변수가 설정되지 않았습니다.');
  }

  const res = await fetch(url, {
    method: 'POST',
    // application/json 으로 보내면 Apps Script 가 프리플라이트를 요구하는 경우가 있어
    // 단순 요청으로 취급되는 text/plain 을 쓴다. e.postData.contents 는 동일하게 읽힌다.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, action, ...extra }),
    redirect: 'follow',
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Apps Script 응답 오류 (${res.status})`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // 로그인 페이지 HTML 이 돌아오는 경우가 대부분 — 배포 접근 권한 설정 문제다.
    throw new Error(
      'Apps Script 응답을 해석할 수 없습니다. 웹앱 배포의 "액세스 권한"이 "모든 사용자"인지 확인해 주세요.',
    );
  }
}
