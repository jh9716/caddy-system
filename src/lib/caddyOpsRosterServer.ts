/**
 * 캐디/조장 /api/summary/ops-roster 전용 per-instance 공유 (READ-ONLY).
 * 관리자 /api/manage/dashboard 경로는 사용하지 않는다(관리자 정확성/동작 그대로).
 *
 * - fresh 결과 memo FRESH_MEMO_MS: 동시 다수 캐디가 같은 view를 공유 → DB/Sheet 재조회 없음
 * - in-flight 공유: 같은 (date, mode) 진행 중 요청은 promise 하나
 * - refresh 실패 결과 memo FAILED_REFRESH_MEMO_MS: Sheet 장애 시 refresh 폭주 방지
 * Sheet HTTP 자체는 기존 offSheetFetch/opsDutySheetFetch 45s 캐시 + in-flight(인스턴스별)를 따른다.
 * Vercel serverless에서는 인스턴스마다 메모리가 분리되므로 인스턴스 수만큼 중복될 수 있다.
 */
import { loadAdminOpsDashboardView } from "@/lib/dailyOpsSnapshotService";
import { toCaddyOpsRoster, type CaddyOpsRosterPayload } from "@/lib/caddyOpsRoster";

export const CADDY_OPS_FRESH_MEMO_MS = 15_000;
export const CADDY_OPS_FAILED_REFRESH_MEMO_MS = 10_000;

type Memo = { date: string; at: number; payload: CaddyOpsRosterPayload };
let freshMemo: Memo | null = null;
let failedRefreshMemo: Memo | null = null;
const inflight = new Map<string, Promise<CaddyOpsRosterPayload>>();

type Loader = (date: string, opts: { waitForSheet: boolean }) => Promise<Parameters<typeof toCaddyOpsRoster>[0]>;

export function resetCaddyOpsRosterServerForTests() {
  freshMemo = null;
  failedRefreshMemo = null;
  inflight.clear();
}

function isFresh(p: CaddyOpsRosterPayload) {
  return p.ready && p.freshness === "fresh";
}

export async function loadCaddyOpsRosterShared(
  date: string,
  refresh: boolean,
  deps: { loader?: Loader; nowMs?: () => number } = {}
): Promise<CaddyOpsRosterPayload> {
  const now = deps.nowMs ?? Date.now;
  const loader: Loader =
    deps.loader ?? ((d, o) => loadAdminOpsDashboardView(d, { waitForSheet: o.waitForSheet }));
  if (freshMemo && freshMemo.date === date && now() - freshMemo.at < CADDY_OPS_FRESH_MEMO_MS) {
    return freshMemo.payload;
  }
  if (
    refresh &&
    failedRefreshMemo &&
    failedRefreshMemo.date === date &&
    now() - failedRefreshMemo.at < CADDY_OPS_FAILED_REFRESH_MEMO_MS
  ) {
    return failedRefreshMemo.payload;
  }
  const key = `${date}:${refresh ? "refresh" : "fast"}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const payload = toCaddyOpsRoster(await loader(date, { waitForSheet: refresh }));
    if (isFresh(payload)) {
      freshMemo = { date, at: now(), payload };
      failedRefreshMemo = null;
    } else if (refresh) {
      failedRefreshMemo = { date, at: now(), payload };
    }
    return payload;
  })().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
