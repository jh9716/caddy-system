/**
 * Client redirect-loop guard (sessionStorage, no PII).
 * Same target redirected more than MAX times within WINDOW_MS → stop and show an error instead.
 */
export const REDIRECT_LOOP_KEY = "vh.redirectLoop.v1";
export const REDIRECT_LOOP_MAX = 3;
export const REDIRECT_LOOP_WINDOW_MS = 15_000;

type Entry = { target: string; at: number[] };

export function nextRedirectLoopState(
  raw: string | null | undefined,
  target: string,
  now: number
): { allow: boolean; serialized: string } {
  let entry: Entry | null = null;
  try {
    const p = raw ? JSON.parse(raw) : null;
    if (p && typeof p.target === "string" && Array.isArray(p.at)) entry = p;
  } catch {
    entry = null;
  }
  const recent =
    entry && entry.target === target
      ? entry.at.filter((t) => typeof t === "number" && now - t < REDIRECT_LOOP_WINDOW_MS)
      : [];
  if (recent.length >= REDIRECT_LOOP_MAX) {
    return { allow: false, serialized: JSON.stringify({ target, at: recent }) };
  }
  return { allow: true, serialized: JSON.stringify({ target, at: [...recent, now] }) };
}

/** true면 리다이렉트해도 됨. 저장소 접근 실패 시 허용(fail-open: 기존 동작 유지). */
export function allowClientRedirect(target: string): boolean {
  try {
    const s = window.sessionStorage;
    const r = nextRedirectLoopState(s.getItem(REDIRECT_LOOP_KEY), target, Date.now());
    s.setItem(REDIRECT_LOOP_KEY, r.serialized);
    return r.allow;
  } catch {
    return true;
  }
}
