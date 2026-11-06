/**
 * Session-revoke room fanout (pure; no Cloudflare imports so it can be unit-tested in Node).
 *
 * 응답 의미(Worker `/internal/session-revoke`):
 * - "ok"      : Directory epoch 기록 + Directory 소켓 종료 + 대상 Room 전부가 revoke 를 2xx 로 확인.
 * - "partial" : Directory epoch 기록·Directory 소켓 종료는 완료, 그러나 하나 이상의 Room 이
 *               실패/시간 초과/예산 초과로 확인되지 않음 → 그 Room 의 열린 소켓이 남아 있을 수 있음.
 *               성공이 아니다(HTTP 502 → Next 가 재시도, 소진 시 failed 로 집계).
 * - "failed"  : Directory 단계 자체 실패(epoch 기록 여부 불명) → HTTP 503.
 * 중복 요청은 안전: Directory/Room 모두 max(sessionVersion) 만 기억하고 소켓 종료는 멱등.
 */

export const ROOM_REVOKE_CONCURRENCY = 6;
export const ROOM_REVOKE_TIMEOUT_MS = 800;
/** 전체 Room fanout 예산. Next 시도당 2.5s 안에 Worker 응답이 도착하도록 여유를 둔다. */
export const ROOM_REVOKE_BUDGET_MS = 1600;

export type RoomPokeOutcome = "ok" | "failed" | "timeout" | "skipped";

export type RoomFanoutSummary = {
  status: "ok" | "partial";
  total: number;
  ok: number;
  failed: number;
  timeout: number;
  skipped: number;
  socketsClosed: number;
  elapsedMs: number;
};

export type RoomPokeResult = { ok: boolean; closed?: number };

const TIMEOUT = Symbol("timeout");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 제한된 동시성 + Room 별 timeout + 전체 예산. 예산이 끝나 시작하지 못한 Room 은 "skipped"(실패로 집계).
 * 부분 실패를 성공으로 보지 않는다: 모든 Room 이 ok 일 때만 status="ok".
 */
export async function fanoutRoomRevoke(
  roomIds: string[],
  poke: (roomId: string) => Promise<RoomPokeResult>,
  opts?: { concurrency?: number; timeoutMs?: number; budgetMs?: number; now?: () => number }
): Promise<RoomFanoutSummary> {
  const now = opts?.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(16, opts?.concurrency ?? ROOM_REVOKE_CONCURRENCY));
  const timeoutMs = Math.max(1, opts?.timeoutMs ?? ROOM_REVOKE_TIMEOUT_MS);
  const budgetMs = Math.max(1, opts?.budgetMs ?? ROOM_REVOKE_BUDGET_MS);
  const started = now();
  const deadline = started + budgetMs;
  const ids = Array.from(new Set(roomIds));
  const outcomes: RoomPokeOutcome[] = new Array(ids.length).fill("skipped");
  let socketsClosed = 0;
  let next = 0;

  async function worker() {
    while (next < ids.length) {
      const i = next++;
      const remaining = deadline - now();
      if (remaining <= 0) {
        outcomes[i] = "skipped";
        continue;
      }
      try {
        const r = await withTimeout(poke(ids[i]!), Math.min(timeoutMs, remaining));
        if (r === TIMEOUT) {
          outcomes[i] = "timeout";
        } else if (r && r.ok) {
          outcomes[i] = "ok";
          const c = Number(r.closed);
          if (Number.isInteger(c) && c > 0) socketsClosed += c;
        } else {
          outcomes[i] = "failed";
        }
      } catch {
        outcomes[i] = "failed";
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  const count = (o: RoomPokeOutcome) => outcomes.filter((x) => x === o).length;
  const ok = count("ok");
  return {
    status: ok === ids.length ? "ok" : "partial",
    total: ids.length,
    ok,
    failed: count("failed"),
    timeout: count("timeout"),
    skipped: count("skipped"),
    socketsClosed,
    elapsedMs: Math.max(0, now() - started),
  };
}

/** HTTP status for a revoke outcome. partial/failed 는 5xx → Next 재시도 대상(성공 아님). */
export function revokeHttpStatus(status: "ok" | "partial" | "failed"): number {
  if (status === "ok") return 200;
  if (status === "partial") return 502;
  return 503;
}
