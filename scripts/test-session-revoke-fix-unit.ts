/**
 * 세션 폐기 결함 수정 — no DB, no network (fetch mock).
 * 1) CSV v2 명단 반영의 퇴사 전환 → 같은 트랜잭션 sessionVersion+1, 커밋 후 폐기 알림
 * 2) 폐기 알림 재시도(네트워크/시간 초과/5xx/429), 4xx 즉시 실패, 실패 로그(식별자 없음)
 */
process.env.NEXT_PUBLIC_CHAT_WS_URL = "wss://chat-worker.invalid";
process.env.CHAT_INTERNAL_SECRET = "unit-test-only-not-a-secret";

import { applyRosterImportPayloadV2, type RosterExisting } from "../lib/caddyRosterImportV2";
import {
  notifyChatSessionRevoked,
  notifyChatSessionRevokedForCaddyLinks,
  notifyChatSessionRevokedForCaddyLinksDetailed,
  summarizeRevokeResults,
  isRetryableRevokeStatus,
  CHAT_SESSION_REVOKE_MAX_ATTEMPTS,
  CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS,
  CHAT_SESSION_REVOKE_TIMEOUT_MS,
} from "../src/lib/chatSessionRevoke";
import { employmentBecameRetired } from "../src/lib/sessionRevocation";
import { xlsxV2ApplySuccessMessage } from "../lib/caddyRosterImportXlsxV2Apply";
import { ROSTER_IMPORT_APPLY_NOTIFY_DEADLINE_MS, ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS } from "../src/lib/caddyRosterImportApplyConfig";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

// ---- fetch mock ----
type Plan = Array<number | "throw" | "hang">;
let plan: Plan = [];
let calls: Array<{ userId: number; sessionVersion: number }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
  const body = JSON.parse(String(init?.body || "{}"));
  calls.push({ userId: body.userId, sessionVersion: body.sessionVersion });
  const step = plan.length ? plan.shift()! : 200;
  if (step === "throw") throw new TypeError("network");
  if (step === "hang") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
  return new Response("{}", { status: step });
}) as typeof fetch;
const errs: string[] = [];
const realErr = console.error;
console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };

// ---- mock prisma ----
type Row = RosterExisting & { missingFromImport?: boolean };
function makeDb(rows: Row[], users: Array<{ id: number; caddyId: number | null; sessionVersion: number }>, opts?: { failAfterBatch?: boolean; noUser?: boolean }) {
  const caddies = new Map(rows.map((r) => [r.id, { ...r }]));
  const userMap = new Map(users.map((u) => [u.id, { ...u }]));
  const make = (): any => {
    const db: any = {
      caddy: {
        findMany: async (args?: any) => {
          let list = [...caddies.values()];
          if (args?.where?.id?.in) list = list.filter((r) => args.where.id.in.includes(r.id));
          return list.map((r) => ({ ...r }));
        },
        updateMany: async (args: any) => {
          let n = 0;
          for (const id of args.where.id.in) { const r = caddies.get(id); if (r) { Object.assign(r, args.data); n++; } }
          return { count: n };
        },
        createManyAndReturn: async () => [],
      },
      $executeRaw: async (q: any) => {
        const text = Array.isArray(q.strings) ? q.strings.join("") : "";
        if (/LOCK\s+TABLE/i.test(text) || q.values.length === 0) return 0;
        let n = 0;
        for (let i = 0; i < q.values.length; i += 13) {
          const v = q.values.slice(i, i + 13);
          const r = caddies.get(Number(v[0]));
          if (!r) continue;
          if (v[1]) r.team = String(v[2]);
          if (v[3]) r.teamOrder = Number(v[4]);
          if (v[5]) r.employmentStatus = String(v[6]);
          n++;
        }
        if (opts?.failAfterBatch) throw new Error("forced failure after batch");
        return n;
      },
    };
    if (!opts?.noUser) {
      db.user = {
        updateMany: async (args: any) => {
          let n = 0;
          for (const u of userMap.values()) if (u.caddyId === args.where.caddyId) { u.sessionVersion += args.data.sessionVersion.increment; n++; }
          return { count: n };
        },
        findMany: async (args: any) => [...userMap.values()].filter((u) => {
          const w = args.where.caddyId;
          return typeof w === "object" ? w.in.includes(u.caddyId) : u.caddyId === w;
        }).map((u) => ({ id: u.id, sessionVersion: u.sessionVersion })),
      };
    }
    return db;
  };
  const db = make();
  db.$transaction = async (fn: any) => {
    const snapC = new Map([...caddies].map(([k, v]) => [k, { ...v }]));
    const snapU = new Map([...userMap].map(([k, v]) => [k, { ...v }]));
    try { return await fn(db); } catch (e) {
      caddies.clear(); for (const [k, v] of snapC) caddies.set(k, v);
      userMap.clear(); for (const [k, v] of snapU) userMap.set(k, v);
      throw e;
    }
  };
  return { db, caddies, userMap };
}
const base = (id: number, team: string, order: number, emp: string): Row => ({ id, name: `캐디${id}`, team, teamOrder: order, employmentStatus: emp, phoneNormalized: null, thirdBandSubgroup: null, caddyType: "HOUSE" } as Row);

(async () => {
  console.log("규칙");
  assert(employmentBecameRetired("ACTIVE", "RETIRED") && employmentBecameRetired("LEAVE", "RETIRED"), "재직/휴직 → 퇴사 = 폐기 대상(개별 퇴사와 같은 함수)");
  assert(!employmentBecameRetired("RETIRED", "RETIRED"), "이미 퇴사 → 대상 아님(중복 폐기 없음)");
  assert(!employmentBecameRetired("RETIRED", "ACTIVE"), "재입사 → 대상 아님");

  console.log("일괄 퇴사(다수)");
  {
    const rows = [base(1, "1조", 1, "ACTIVE"), base(2, "1조", 2, "LEAVE"), base(3, "1조", 3, "RETIRED"), base(4, "1조", 4, "ACTIVE")];
    const users = [{ id: 11, caddyId: 1, sessionVersion: 3 }, { id: 12, caddyId: 2, sessionVersion: 0 }, { id: 13, caddyId: 3, sessionVersion: 5 }, { id: 14, caddyId: 4, sessionVersion: 1 }];
    const { db, userMap } = makeDb(rows, users);
    calls = []; plan = [];
    const r = await applyRosterImportPayloadV2({ updates: [
      { id: 1, employmentStatus: "RETIRED" }, { id: 2, employmentStatus: "RETIRED" }, { id: 3, employmentStatus: "RETIRED" }, { id: 4, team: "1조", teamOrder: 4, employmentStatus: "ACTIVE" },
    ], creates: [] } as any, db, { existingForGuard: rows });
    assert(userMap.get(11)!.sessionVersion === 4 && userMap.get(12)!.sessionVersion === 1, "실제 전환된 2명만 sv+1");
    assert(userMap.get(13)!.sessionVersion === 5, "이미 퇴사였던 계정 sv 유지");
    assert(userMap.get(14)!.sessionVersion === 1, "퇴사 아닌 변경 계정 sv 유지");
    assert(r.sessionsRevoked === 2 && r.chatRevokeFailed === 0, "결과: 폐기 2, 알림 실패 0");
    assert(calls.length === 2 && calls.every((c) => [11, 12].includes(c.userId)), "커밋 후 전환 계정에만 알림");
    assert(calls.find((c) => c.userId === 11)!.sessionVersion === 4, "알림은 증가 후 최신 sv");
  }

  console.log("재입사·상태 변경(퇴사 아님)");
  {
    const rows = [base(5, "2조", 1, "RETIRED"), base(6, "2조", 2, "ACTIVE")];
    const { db, userMap } = makeDb(rows, [{ id: 15, caddyId: 5, sessionVersion: 2 }, { id: 16, caddyId: 6, sessionVersion: 2 }]);
    calls = [];
    const r = await applyRosterImportPayloadV2({ updates: [{ id: 5, team: "2조", teamOrder: 1, employmentStatus: "ACTIVE" }, { id: 6, employmentStatus: "LEAVE" }], creates: [] } as any, db, { existingForGuard: rows });
    assert(userMap.get(15)!.sessionVersion === 2 && userMap.get(16)!.sessionVersion === 2, "재입사·휴직 전환은 sv 변경 없음(기존 규칙)");
    assert(calls.length === 0 && r.sessionsRevoked === 0, "알림 없음");
  }

  console.log("트랜잭션 실패 → 롤백·알림 없음");
  {
    const rows = [base(7, "3조", 1, "ACTIVE")];
    const { db, userMap, caddies } = makeDb(rows, [{ id: 17, caddyId: 7, sessionVersion: 0 }], { failAfterBatch: true });
    calls = [];
    let threw = false;
    try { await applyRosterImportPayloadV2({ updates: [{ id: 7, employmentStatus: "RETIRED" }], creates: [] } as any, db, { existingForGuard: rows }); } catch { threw = true; }
    assert(threw && caddies.get(7)!.employmentStatus === "ACTIVE" && userMap.get(17)!.sessionVersion === 0, "실패 시 퇴사·sv 모두 롤백");
    assert(calls.length === 0, "커밋 안 됐으면 알림 없음");
  }

  console.log("세션 저장소 없음 → fail-closed");
  {
    const rows = [base(8, "4조", 1, "ACTIVE")];
    const { db, caddies } = makeDb(rows, [], { noUser: true });
    let threw = false;
    try { await applyRosterImportPayloadV2({ updates: [{ id: 8, employmentStatus: "RETIRED" }], creates: [] } as any, db, { existingForGuard: rows }); } catch { threw = true; }
    assert(threw && caddies.get(8)!.employmentStatus === "ACTIVE", "sv 증가 불가면 퇴사 반영도 하지 않음");
  }

  console.log("알림 재시도·실패");
  calls = []; plan = ["throw", 503, 200];
  assert((await notifyChatSessionRevoked({ userId: 21, sessionVersion: 2 })) === "ok" && calls.length === 3, "네트워크·503 후 재시도 성공");
  calls = []; plan = ["hang", "hang", "hang"]; errs.length = 0;
  assert((await notifyChatSessionRevoked({ userId: 21, sessionVersion: 2 })) === "failed" && calls.length >= 2 && calls.length <= CHAT_SESSION_REVOKE_MAX_ATTEMPTS, "시간 초과 반복 → failed(최대 3회)");
  assert(errs.some((e) => e.includes("notify failed status=network")) && !errs.some((e) => /21|sessionVersion|secret/.test(e)), "실패 로그(식별자·비밀값 없음)");
  calls = []; plan = [403];
  assert((await notifyChatSessionRevoked({ userId: 21, sessionVersion: 2 })) === "failed" && calls.length === 1, "403(서명/설정) → 재시도 없이 실패");
  calls = []; plan = [429, 200];
  assert((await notifyChatSessionRevoked({ userId: 21, sessionVersion: 2 })) === "ok" && calls.length === 2, "429 재시도");
  assert(isRetryableRevokeStatus(null) && isRetryableRevokeStatus(500) && !isRetryableRevokeStatus(401) && !isRetryableRevokeStatus(404), "재시도 판정");

  console.log("전체 시간 상한(응답 없는 Worker)");
  {
    const prev = globalThis.fetch;
    globalThis.fetch = ((_u: unknown, init?: { signal?: AbortSignal }) => new Promise((_, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" })));
    })) as typeof fetch;
    const keep = setInterval(() => undefined, 100); // AbortSignal.timeout 타이머는 unref → 이벤트 루프 유지
    const t0 = Date.now();
    const r = await notifyChatSessionRevoked({ userId: 23, sessionVersion: 1 });
    clearInterval(keep);
    const el = Date.now() - t0;
    globalThis.fetch = prev;
    assert(r === "failed" && el >= CHAT_SESSION_REVOKE_TIMEOUT_MS - 50 && el <= CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS + 300, `재시도 포함 상한 이내(${el}ms)`);
  }

  console.log("중복 알림 안전성");
  calls = []; plan = [200, 200];
  await notifyChatSessionRevoked({ userId: 22, sessionVersion: 7 });
  await notifyChatSessionRevoked({ userId: 22, sessionVersion: 7 });
  assert(calls.length === 2 && calls.every((c) => c.sessionVersion === 7), "같은 sv 반복 전송(Worker 는 max 보관 → 되돌림 없음)");

  console.log("일괄 알림 일부 실패 집계");
  {
    const { db } = makeDb([], [{ id: 31, caddyId: 1, sessionVersion: 1 }, { id: 32, caddyId: 2, sessionVersion: 1 }]);
    calls = []; plan = [200, 400];
    const res = await notifyChatSessionRevokedForCaddyLinks(db, [1, 2, 2]);
    assert(res.length === 2 && res.filter((x) => x === "failed").length === 1, "중복 caddyId 제거, 실패 1건 집계");
  }

  console.log("skipped/설정 없음 구분 (결함 보완 1)");
  {
    const { db } = makeDb([], [{ id: 41, caddyId: 1, sessionVersion: 1 }, { id: 42, caddyId: 2, sessionVersion: 1 }]);
    calls = []; errs.length = 0;
    const nc = await notifyChatSessionRevokedForCaddyLinksDetailed(db, [1, 2], { configured: false });
    assert(nc.status === "not_configured" && nc.notConfigured === 2 && nc.notified === 0 && calls.length === 0, "대상 있음 + 설정 없음 → not_configured(성공 아님), 전송 없음");
    assert(errs.some((e) => e.includes("not configured: 2 target")) && !errs.some((e) => e.includes("unit-test-only") || e.includes("invalid")), "로그에 개수만, 설정 값 없음");
    const none = await notifyChatSessionRevokedForCaddyLinksDetailed(db, [99]);
    assert(none.status === "none" && none.targets === 0, "연결 계정 없는 캐디 → none(정상)");
    plan = [200, 200];
    const okS = await notifyChatSessionRevokedForCaddyLinksDetailed(db, [1, 2]);
    assert(okS.status === "ok" && okS.notified === 2, "전부 성공 → ok");
    plan = [200, 400];
    const part = await notifyChatSessionRevokedForCaddyLinksDetailed(db, [1, 2]);
    assert(part.status === "partial" && part.failed === 1, "일부 실패 → partial");
    assert(summarizeRevokeResults(["failed", "failed"], 2).status === "failed", "전부 실패 → failed");
    const badLookup = await notifyChatSessionRevokedForCaddyLinksDetailed({ user: { findMany: async () => { throw new Error("db"); } } }, [1, 2]);
    assert(badLookup.status === "failed" && badLookup.failed === 2, "대상 조회 실패 → failed(성공 아님)");
  }

  console.log("시간 상한(결함 보완 2)");
  {
    const users = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, caddyId: 200 + i, sessionVersion: 1 }));
    const { db } = makeDb([], users);
    calls = []; plan = [];
    const dl = await notifyChatSessionRevokedForCaddyLinksDetailed(db, users.map((u) => u.caddyId), { deadlineAt: Date.now() + 1000, concurrency: 8 });
    assert(dl.deadlineSkipped === 20 && dl.status === "failed" && calls.length === 0, "남은 시간 < 계정당 상한 → 시작 안 하고 deadline 으로 보고");
    calls = []; plan = [];
    const ok20 = await notifyChatSessionRevokedForCaddyLinksDetailed(db, users.map((u) => u.caddyId), { deadlineAt: Date.now() + 60_000, concurrency: 8 });
    assert(ok20.status === "ok" && ok20.notified === 20 && calls.length === 20, "충분하면 전부 전송");
    assert(ROSTER_IMPORT_APPLY_NOTIFY_DEADLINE_MS === ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS * 1000 - 15_000, "알림 상한 = maxDuration − 15초");
  }

  console.log("CSV 반영 결과 보고");
  {
    const rows = [base(51, "5조", 1, "ACTIVE")];
    const { db } = makeDb(rows, [{ id: 61, caddyId: 51, sessionVersion: 0 }]);
    const prevUrl = process.env.NEXT_PUBLIC_CHAT_WS_URL; const prevSec = process.env.CHAT_INTERNAL_SECRET;
    delete process.env.CHAT_INTERNAL_SECRET;
    const r = await applyRosterImportPayloadV2({ updates: [{ id: 51, employmentStatus: "RETIRED" }], creates: [] } as any, db, { existingForGuard: rows });
    process.env.NEXT_PUBLIC_CHAT_WS_URL = prevUrl; process.env.CHAT_INTERNAL_SECRET = prevSec;
    assert(r.sessionsRevoked === 1 && r.chatRevoke?.status === "not_configured" && r.chatRevokeFailed === 1, "설정 없음 → 커밋 결과 유지 + 미전송 1건 보고(성공으로 표시 안 함)");
  }
  {
    const rows = [base(52, "5조", 2, "ACTIVE")];
    const { db, userMap } = makeDb(rows, [{ id: 62, caddyId: 52, sessionVersion: 0 }]);
    calls = []; plan = [500, 500, 500];
    const r = await applyRosterImportPayloadV2({ updates: [{ id: 52, employmentStatus: "RETIRED" }], creates: [] } as any, db, { existingForGuard: rows });
    assert(r.updated === 1 && userMap.get(62)!.sessionVersion === 1 && r.chatRevoke?.status === "failed", "알림 실패여도 반영은 성공으로 반환(이미 커밋), 실패 개수 보고");
    calls = [];
    const again = await applyRosterImportPayloadV2({ updates: [{ id: 52, employmentStatus: "RETIRED" }], creates: [] } as any, db, { existingForGuard: [{ ...rows[0], employmentStatus: "RETIRED" }] });
    assert(userMap.get(62)!.sessionVersion === 1 && again.sessionsRevoked === 0 && calls.length === 0, "같은 반영 중복 요청 → sv 추가 증가 없음·알림 없음");
  }
  assert(xlsxV2ApplySuccessMessage({ ok: true, created: 0, updated: 0, retired: 2, drivingChanged: 0, sessionsRevoked: 2, chatRevoke: { status: "partial", targets: 2, notified: 1, failed: 1, notConfigured: 0, deadlineSkipped: 0 } } as any).includes("미완료 1건"), "XLSX 메시지에 미완료 표시");
  assert(!xlsxV2ApplySuccessMessage({ ok: true, created: 0, updated: 0, retired: 1, drivingChanged: 0, sessionsRevoked: 1, chatRevoke: { status: "ok", targets: 1, notified: 1, failed: 0, notConfigured: 0, deadlineSkipped: 0 } } as any).includes("미완료"), "모두 성공이면 기존 메시지");

  globalThis.fetch = realFetch;
  console.error = realErr;
  console.log(`\nsession-revoke-fix-unit: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
