/**
 * Room revoke fanout + 열린 소켓 재검증 규칙 (pure, Node 타입 제거 로더로 .ts 직접 import).
 * Worker·DB·네트워크 없음.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_REVOKE_BUDGET_MS,
  ROOM_REVOKE_CONCURRENCY,
  ROOM_REVOKE_TIMEOUT_MS,
  fanoutRoomRevoke,
  revokeHttpStatus,
} from "../src/revokeFanout.ts";
import {
  OPEN_SOCKET_RECHECK_MS,
  classifySessionProbe,
  isRecheckDue,
  openSocketRecheckIntervalMs,
  retryCheckedAt,
} from "../src/openSocketRecheck.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rooms = (n) => Array.from({ length: n }, (_, i) => `room-${i}`);

test("constants fit Next per-attempt timeout (2.5s)", () => {
  assert.ok(ROOM_REVOKE_BUDGET_MS + 600 < 2500, "directory timeout < Next attempt timeout");
  assert.ok(ROOM_REVOKE_TIMEOUT_MS <= ROOM_REVOKE_BUDGET_MS);
  assert.ok(ROOM_REVOKE_CONCURRENCY >= 2 && ROOM_REVOKE_CONCURRENCY <= 8, "bounded concurrency");
});

test("1. all rooms ok → status ok, counts, sockets closed summed", async () => {
  const r = await fanoutRoomRevoke(rooms(13), async () => ({ ok: true, closed: 1 }));
  assert.equal(r.status, "ok");
  assert.equal(r.total, 13);
  assert.equal(r.ok, 13);
  assert.equal(r.socketsClosed, 13);
  assert.equal(revokeHttpStatus(r.status), 200);
});

test("3. some rooms fail (throw / non-2xx) → partial, not success", async () => {
  const r = await fanoutRoomRevoke(rooms(10), async (id) => {
    if (id === "room-3") throw new Error("do unavailable");
    if (id === "room-7") return { ok: false };
    return { ok: true };
  });
  assert.equal(r.status, "partial");
  assert.equal(r.ok, 8);
  assert.equal(r.failed, 2);
  assert.equal(revokeHttpStatus(r.status), 502);
  assert.equal(revokeHttpStatus("failed"), 503);
});

test("2/3. slow room → per-room timeout, others still poked, bounded wall time", async () => {
  const t0 = Date.now();
  const r = await fanoutRoomRevoke(
    rooms(8),
    async (id) => {
      if (id === "room-0") await sleep(5000);
      return { ok: true };
    },
    { timeoutMs: 200, budgetMs: 1000 }
  );
  const el = Date.now() - t0;
  assert.equal(r.status, "partial");
  assert.equal(r.timeout, 1);
  assert.equal(r.ok, 7);
  assert.ok(el < 600, `bounded (${el}ms)`);
});

test("budget exhausted → remaining rooms skipped (counted as failure)", async () => {
  const r = await fanoutRoomRevoke(
    rooms(10),
    async () => {
      await sleep(150);
      return { ok: true };
    },
    { concurrency: 2, timeoutMs: 500, budgetMs: 320 }
  );
  assert.equal(r.status, "partial");
  assert.ok(r.skipped >= 1, `skipped=${r.skipped}`);
  assert.equal(r.ok + r.failed + r.timeout + r.skipped, r.total);
});

test("bounded concurrency respected; duplicates de-duplicated", async () => {
  let inflight = 0;
  let peak = 0;
  const seen = [];
  const r = await fanoutRoomRevoke(
    [...rooms(20), "room-1", "room-2"],
    async (id) => {
      seen.push(id);
      inflight++;
      peak = Math.max(peak, inflight);
      await sleep(20);
      inflight--;
      return { ok: true };
    },
    { concurrency: 4 }
  );
  assert.equal(r.total, 20);
  assert.equal(seen.length, 20);
  assert.ok(peak <= 4, `peak=${peak}`);
  assert.equal(r.status, "ok");
});

test("open-socket recheck rules", () => {
  assert.equal(openSocketRecheckIntervalMs(undefined), OPEN_SOCKET_RECHECK_MS);
  assert.equal(openSocketRecheckIntervalMs(""), OPEN_SOCKET_RECHECK_MS);
  assert.equal(openSocketRecheckIntervalMs("abc"), OPEN_SOCKET_RECHECK_MS);
  assert.equal(openSocketRecheckIntervalMs("5"), 1000, "clamped min 1s");
  assert.equal(openSocketRecheckIntervalMs(String(99 * 60 * 1000)), 30 * 60 * 1000, "clamped max 30m");
  const now = 1_000_000_000;
  assert.equal(isRecheckDue(undefined, now, 300000), true, "no sc → due");
  assert.equal(isRecheckDue(now - 1000, now, 300000), false);
  assert.equal(isRecheckDue(now - 300000, now, 300000), true);
  assert.equal(isRecheckDue(retryCheckedAt(now, 300000), now + 59_000, 300000), false, "retry backoff 60s");
  assert.equal(isRecheckDue(retryCheckedAt(now, 300000), now + 60_000, 300000), true);
  assert.equal(classifySessionProbe(200, { ok: true }), "current");
  assert.equal(classifySessionProbe(401, { ok: false, code: "stale_session" }), "revoked");
  assert.equal(classifySessionProbe(401, { ok: false, code: "user_unavailable" }), "revoked");
  assert.equal(classifySessionProbe(401, { error: "other" }), "unknown", "unknown 401 does not close");
  assert.equal(classifySessionProbe(403, { error: "forbidden" }), "unknown", "auth misconfig does not close");
  assert.equal(classifySessionProbe(503, { error: "auth_unavailable" }), "unknown", "Next down does not close");
  assert.equal(classifySessionProbe(200, null), "unknown");
});
