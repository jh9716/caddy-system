/**
 * Client auto-redirect loop guard (sessionStorage, PII 없음). 경로 무관(path-agnostic).
 * - 자동 리다이렉트 직전 recordAutoRedirect()를 호출한다. WINDOW_MS 안에 MAX회를 넘으면 false → 이동 중단, 오류 화면.
 * - 화면이 정상 렌더되면 resetAutoRedirects()로 카운터를 비운다 (정상 이동·새로고침·뒤로가기는 매번 렌더로 초기화).
 * - sessionStorage 오류 시 허용(fail-open: 기존 동작 유지).
 */
export const AUTO_REDIRECT_KEY = "vh.autoRedirect.v2";
export const AUTO_REDIRECT_MAX = 4;
export const AUTO_REDIRECT_WINDOW_MS = 15_000;

export function nextAutoRedirectState(
  raw: string | null | undefined,
  now: number
): { allow: boolean; serialized: string } {
  let at: number[] = [];
  try {
    const p = raw ? JSON.parse(raw) : null;
    if (Array.isArray(p)) at = p.filter((t) => typeof t === "number");
  } catch {
    at = [];
  }
  const recent = at.filter((t) => now - t >= 0 && now - t < AUTO_REDIRECT_WINDOW_MS);
  if (recent.length >= AUTO_REDIRECT_MAX) {
    return { allow: false, serialized: JSON.stringify(recent) };
  }
  return { allow: true, serialized: JSON.stringify([...recent, now]) };
}

export function recordAutoRedirect(): boolean {
  try {
    const s = window.sessionStorage;
    const r = nextAutoRedirectState(s.getItem(AUTO_REDIRECT_KEY), Date.now());
    s.setItem(AUTO_REDIRECT_KEY, r.serialized);
    return r.allow;
  } catch {
    return true;
  }
}

export function resetAutoRedirects(): void {
  try {
    window.sessionStorage.removeItem(AUTO_REDIRECT_KEY);
  } catch {
    /* ignore */
  }
}
