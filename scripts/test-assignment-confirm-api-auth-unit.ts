/**
 * POST /api/assignments/confirm — 인증 + 라우트 연결 단위 테스트 (DB 없음)
 *
 * ⛔ 실제 DB 연결 없음:
 *   - src/lib/prisma.ts 는 globalThis.prisma 가 있으면 새 PrismaClient 를 만들지 않는다.
 *     → 라우트를 import 하기 전에 가짜 객체(일반 객체 + Proxy)를 globalThis.prisma 에 넣는다.
 *   - DATABASE_URL/DIRECT_URL 은 접속 불가능한 주소(invalid.invalid, RFC 2606)로 덮어쓴다.
 *   - 가짜 객체에 없는 모델/메서드를 건드리면 즉시 실패한다.
 *
 * 실제 인증 코드(requireAdmin, 서명 검증)와 실제 라우트/저장 함수를 그대로 실행한다.
 * 실제 DB 저장·트랜잭션 롤백·제약조건은 여기서 검증하지 않는다
 * (scripts/test-assignment-confirm-unit.ts 의 ALLOW_DB_TEST 로컬 DB 통합 테스트 담당).
 *
 * 실행: bash scripts/tsx-safe.sh scripts/test-assignment-confirm-api-auth-unit.ts
 */
import type { NextRequest as NextRequestType } from "next/server";
import type { AutoAssignmentRow } from "../src/lib/autoAssignEngine";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

/** 테스트 전용 고정 서명 비밀값 — 운영 값과 무관 */
const TEST_SESSION_SECRET = "assignment-confirm-api-auth-test-only-secret!!";
const OTHER_SECRET = "a-different-test-only-secret-not-the-server-one!!";
const UNREACHABLE_DB_URL = "postgresql://blocked:blocked@invalid.invalid:1/none";
const ENV_KEYS = [
  "SESSION_SECRET",
  "AUTH_SECRET",
  "NEXTAUTH_SECRET",
  "DATABASE_URL",
  "DIRECT_URL",
] as const;

// ─── 가짜 Prisma (일반 객체, 네트워크 없음) ─────────────────────────────
type Call = { op: string; args: unknown };

type FakeState = {
  users: Map<number, Record<string, unknown>>;
  userLookupThrows: boolean;
  caddies: Array<{ id: number; name: string; employmentStatus: string }>;
  existing: { schedules: number; shiftDuties: number; extraTags: number };
  audits: Array<{ id: number; payload: Record<string, unknown> }>;
  transactionThrows: boolean;
  nextAuditId: number;
  calls: Call[];
};

const state: FakeState = {
  users: new Map(),
  userLookupThrows: false,
  caddies: [],
  existing: { schedules: 0, shiftDuties: 0, extraTags: 0 },
  audits: [],
  transactionThrows: false,
  nextAuditId: 1000,
  calls: [],
};

function resetState() {
  state.users = new Map();
  state.userLookupThrows = false;
  state.caddies = [
    { id: 11, name: "__API_CONFIRM_1__", employmentStatus: "ACTIVE" },
    { id: 12, name: "__API_CONFIRM_2__", employmentStatus: "ACTIVE" },
  ];
  state.existing = { schedules: 0, shiftDuties: 0, extraTags: 0 };
  state.audits = [];
  state.transactionThrows = false;
  state.nextAuditId = 1000;
  state.calls = [];
}

/** 정의되지 않은 모델/메서드 접근은 즉시 throw → 예상 밖 DB 사용을 숨기지 않는다. */
function strict<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") {
        return Reflect.get(t, prop, recv);
      }
      if (!(prop in t)) {
        throw new Error(`unexpected fake prisma access: ${name}.${String(prop)}`);
      }
      return Reflect.get(t, prop, recv);
    },
  });
}

function record(op: string, args: unknown) {
  state.calls.push({ op, args });
}

function makeTx() {
  return strict("tx", {
    shiftDuty: strict("tx.shiftDuty", {
      deleteMany: async (a: unknown) => (record("tx.shiftDuty.deleteMany", a), { count: 0 }),
      createMany: async (a: { data: unknown[] }) => (
        record("tx.shiftDuty.createMany", a), { count: a.data.length }
      ),
    }),
    schedule: strict("tx.schedule", {
      deleteMany: async (a: unknown) => (record("tx.schedule.deleteMany", a), { count: 0 }),
      createMany: async (a: { data: unknown[] }) => (
        record("tx.schedule.createMany", a), { count: a.data.length }
      ),
    }),
    scheduleExtraTag: strict("tx.scheduleExtraTag", {
      deleteMany: async (a: unknown) => (
        record("tx.scheduleExtraTag.deleteMany", a), { count: 0 }
      ),
      createMany: async (a: { data: unknown[] }) => (
        record("tx.scheduleExtraTag.createMany", a), { count: a.data.length }
      ),
    }),
    audit: strict("tx.audit", {
      create: async (a: { data: { payload: Record<string, unknown> } }) => {
        record("tx.audit.create", a);
        const id = state.nextAuditId++;
        state.audits.unshift({ id, payload: a.data.payload });
        return { id };
      },
    }),
  });
}

const fakePrisma = strict("prisma", {
  user: strict("prisma.user", {
    findUnique: async (a: { where: { id: number } }) => {
      record("user.findUnique", a);
      if (state.userLookupThrows) throw new Error("fake auth store down");
      return state.users.get(a.where.id) ?? null;
    },
  }),
  caddy: strict("prisma.caddy", {
    findMany: async (a: { where: { id: { in: number[] } } }) => {
      record("caddy.findMany", a);
      const ids = new Set(a.where.id.in);
      return state.caddies.filter((c) => ids.has(c.id));
    },
  }),
  audit: strict("prisma.audit", {
    findMany: async (a: unknown) => (record("audit.findMany", a), state.audits.slice(0, 50)),
  }),
  schedule: strict("prisma.schedule", {
    count: async (a: unknown) => (record("schedule.count", a), state.existing.schedules),
  }),
  shiftDuty: strict("prisma.shiftDuty", {
    count: async (a: unknown) => (record("shiftDuty.count", a), state.existing.shiftDuties),
  }),
  scheduleExtraTag: strict("prisma.scheduleExtraTag", {
    count: async (a: unknown) => (
      record("scheduleExtraTag.count", a), state.existing.extraTags
    ),
  }),
  $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
    record("$transaction", null);
    if (state.transactionThrows) throw new Error("fake transaction failure");
    return cb(makeTx());
  },
});

function ops(): string[] {
  return state.calls.map((c) => c.op);
}

// ─── fixtures ──────────────────────────────────────────────────────────
const DATE = "2099-02-10";

function row(
  caddyId: number,
  teeTime: string,
  shift: "1부" | "2부",
  kind: AutoAssignmentRow["kind"]
): AutoAssignmentRow {
  return {
    date: DATE,
    shift,
    sequenceIndex: 1,
    reason: "TEST",
    kind,
    note: null,
    pairId: null,
    reservation: {
      id: `r-${caddyId}-${teeTime}`,
      date: DATE,
      course: "SKY",
      shift,
      teeTime,
      teamName: "t",
      rawRowIndex: caddyId,
    },
    caddy: { id: caddyId, name: `C${caddyId}`, team: "1조", teamOrder: 1 },
  };
}

const ASSIGNMENTS: AutoAssignmentRow[] = [
  row(11, "07:00", "1부", "regular"),
  row(12, "13:00", "2부", "oneTwo"),
];

function confirmBody(extra: Record<string, unknown> = {}) {
  return { status: "CONFIRMED", date: DATE, assignments: ASSIGNMENTS, ...extra };
}

async function main() {
  // ── 0. 환경 격리: 이전 값은 복원용으로만 보관(출력하지 않음) ──
  const savedEnv = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  const g = globalThis as unknown as { prisma?: unknown };
  const hadGlobalPrisma = Object.prototype.hasOwnProperty.call(g, "prisma");
  const savedGlobalPrisma = g.prisma;

  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;
  process.env.DATABASE_URL = UNREACHABLE_DB_URL;
  process.env.DIRECT_URL = UNREACHABLE_DB_URL;

  // ── 1. 가짜 DB 주입 — 반드시 src 모듈 import 전에 ──
  g.prisma = fakePrisma;

  try {
    const { NextRequest } = await import("next/server");
    const prismaModule = await import("../src/lib/prisma");
    const { POST: confirmPOST } = await import("../src/app/api/assignments/confirm/route");
    const { SESSION_COOKIE_NAME, buildSessionClaims, signSessionClaims } = await import(
      "../src/lib/sessionCookies"
    );

    section("DB 격리 확인");
    assert((prismaModule.prisma as unknown) === fakePrisma, "src/lib/prisma exports the injected fake");
    assert((prismaModule.default as unknown) === fakePrisma, "default export is the fake");
    assert(g.prisma === fakePrisma, "globalThis.prisma still the fake (no new PrismaClient)");

    type Role = "admin" | "caddy" | "leader";
    async function token(input: {
      userId?: number | null;
      username?: string;
      role?: Role;
      sv?: number;
      nowSec?: number;
      maxAgeSec?: number;
      secret?: string;
    }) {
      return signSessionClaims(
        buildSessionClaims({
          userId: input.userId ?? null,
          username: input.username ?? "admin",
          role: input.role ?? "admin",
          sessionVersion: input.sv ?? 0,
          nowSec: input.nowSec,
          maxAgeSec: input.maxAgeSec,
        }),
        input.secret
      );
    }
    function req(cookie: string | null, body: unknown = confirmBody()): NextRequestType {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      };
      if (cookie != null) headers.cookie = cookie;
      return new NextRequest("http://localhost/api/assignments/confirm", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }
    const sess = (t: string) => `${SESSION_COOKIE_NAME}=${t}`;
    async function call(cookie: string | null, body?: unknown) {
      const res = await confirmPOST(req(cookie, body));
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, body: json, res };
    }
    function noStorage(label: string) {
      const storage = ops().filter((o) => o !== "user.findUnique");
      assert(storage.length === 0, `${label}: storage function not reached`);
    }

    // ── 2. 인증 거절 ──
    section("인증 거절 (401)");
    {
      resetState();
      const r = await call(null);
      assert(r.status === 401 && r.body?.error === "unauthorized", "no cookie → 401");
      assert(state.calls.length === 0, "no cookie: no DB call at all");
    }
    {
      resetState();
      const r = await call("role=admin; session_role=admin; session_user=admin; admin=1");
      assert(r.status === 401 && r.body?.error === "unauthorized", "unsigned legacy admin cookies → 401");
      assert(state.calls.length === 0, "legacy cookie: no DB call at all");
    }
    {
      resetState();
      // caddy 로 정상 서명 후 본문만 admin 으로 바꿔치기 (서명 그대로)
      const t = await token({ role: "caddy", username: "kim" });
      const [bodyB64, sig] = t.split(".");
      const canonical = Buffer.from(bodyB64, "base64url").toString("utf8");
      const forged = canonical.replace("|kim|caddy|", "|kim|admin|");
      assert(forged !== canonical, "forged payload differs");
      const forgedToken = `${Buffer.from(forged, "utf8").toString("base64url")}.${sig}`;
      const r = await call(sess(forgedToken));
      assert(r.status === 401, "role-tampered token (signature mismatch) → 401");
      noStorage("tampered");
    }
    {
      resetState();
      const t = await token({ secret: OTHER_SECRET });
      const r = await call(sess(t));
      assert(r.status === 401, "admin token signed with a different secret → 401");
      noStorage("wrong secret");
    }
    {
      resetState();
      const t = await token({});
      const r = await call(sess(t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA")));
      assert(r.status === 401, "signature bytes altered → 401");
      noStorage("altered signature");
    }
    {
      resetState();
      const now = Math.floor(Date.now() / 1000);
      const t = await token({ nowSec: now - 7200, maxAgeSec: 60 });
      const r = await call(sess(t));
      assert(r.status === 401, "expired admin session → 401");
      noStorage("expired");
    }
    {
      resetState();
      const now = Math.floor(Date.now() / 1000);
      const t = await token({ nowSec: now + 3600 });
      const r = await call(sess(t));
      assert(r.status === 401, "future-issued (iat) admin session → 401");
      noStorage("future iat");
    }
    for (const role of ["caddy", "leader"] as const) {
      resetState();
      const t = await token({ role, username: role });
      const r = await call(sess(t));
      assert(r.status === 401 && r.body?.error === "unauthorized", `signed ${role} (env) → 401`);
      noStorage(role);
    }
    {
      resetState();
      const t = await token({});
      delete process.env.SESSION_SECRET;
      try {
        const r = await call(sess(t));
        assert(r.status === 401, "server has no session secret → 401 (fail closed)");
        noStorage("no secret");
      } finally {
        process.env.SESSION_SECRET = TEST_SESSION_SECRET;
      }
    }

    // ── 3. DB 사용자 경로 (가짜 user.findUnique) ──
    section("DB 사용자 세션 (role/sessionVersion/비밀번호 변경)");
    const dbAdmin = {
      id: 501,
      username: "boss",
      role: "admin",
      sessionVersion: 3,
      caddyId: null,
      managedTeams: [],
      mustChangePassword: false,
      caddy: null,
    };
    {
      resetState();
      state.users.set(501, { ...dbAdmin, sessionVersion: 4 });
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 401, "sessionVersion mismatch (revoked) → 401");
      const look = state.calls.find((c) => c.op === "user.findUnique");
      assert(
        (look?.args as { where?: { id?: number } })?.where?.id === 501,
        "auth looked up the signed uid"
      );
      noStorage("sv mismatch");
    }
    {
      resetState();
      state.users.set(501, { ...dbAdmin, role: "caddy" });
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 401, "token says admin but DB role is caddy → 401");
      noStorage("db role");
    }
    {
      resetState();
      state.users.set(501, { ...dbAdmin, username: "someone-else" });
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 401, "username mismatch with DB → 401");
      noStorage("username");
    }
    {
      resetState();
      const t = await token({ userId: 999, username: "ghost", sv: 0 });
      const r = await call(sess(t));
      assert(r.status === 401, "signed uid not in DB → 401");
      noStorage("missing user");
    }
    {
      resetState();
      state.users.set(501, { ...dbAdmin, mustChangePassword: true });
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 403, "DB admin with mustChangePassword → 403");
      assert(r.body?.error === "MUST_CHANGE_PASSWORD", "403 body MUST_CHANGE_PASSWORD");
      noStorage("must change password");
    }
    {
      resetState();
      state.userLookupThrows = true;
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 503, "auth store unavailable → 503 (fail closed)");
      noStorage("auth store down");
    }

    // ── 4. 정상 관리자 → 실제 라우트 + 실제 저장 함수 ──
    function checkStorageCalls(label: string, opts: { replace: boolean }) {
      const o = ops();
      const sched = state.calls.find((c) => c.op === "tx.schedule.createMany")?.args as
        | { data: Array<{ date: Date; caddyId: number }> }
        | undefined;
      const duties = state.calls.find((c) => c.op === "tx.shiftDuty.createMany")?.args as
        | { data: Array<{ date: Date; part: string; orderNo: number; caddyId: number }> }
        | undefined;
      const tags = state.calls.find((c) => c.op === "tx.scheduleExtraTag.createMany")?.args as
        | { data: Array<{ caddyId: number }> }
        | undefined;
      const audit = state.calls.find((c) => c.op === "tx.audit.create")?.args as
        | { data: { action: string; entity: string; ip: string | null; payload: Record<string, unknown> } }
        | undefined;
      assert(o.includes("caddy.findMany"), `${label}: caddy existence checked`);
      assert(o.includes("audit.findMany"), `${label}: duplicate check ran`);
      assert(o.filter((x) => x === "$transaction").length === 1, `${label}: one transaction`);
      assert(
        o.includes("tx.schedule.deleteMany") === opts.replace,
        `${label}: delete-before-write only when replace (${opts.replace})`
      );
      assert(
        sched?.data.length === 2 &&
          sched.data.map((d) => d.caddyId).sort().join(",") === "11,12" &&
          sched.data.every((d) => d.date instanceof Date && d.date.toISOString() === `${DATE}T00:00:00.000Z`),
        `${label}: schedules for caddy 11,12 on ${DATE} (UTC midnight)`
      );
      assert(
        duties?.data.length === 2 &&
          duties.data.some((d) => d.caddyId === 11 && d.part === "ONE" && d.orderNo === 1) &&
          duties.data.some((d) => d.caddyId === 12 && d.part === "TWO" && d.orderNo === 1),
        `${label}: shift duties 1부/2부 written`
      );
      assert(tags?.data.length === 1 && tags.data[0].caddyId === 12, `${label}: 1·2부 extra tag`);
      assert(
        audit?.data.action === "ASSIGNMENTS_CONFIRM" &&
          audit.data.entity === "AssignmentConfirm" &&
          audit.data.payload.status === "APPLIED" &&
          audit.data.payload.date === DATE,
        `${label}: audit row APPLIED`
      );
      assert(audit?.data.ip === "203.0.113.7", `${label}: first x-forwarded-for IP passed to storage`);
    }

    section("정상 관리자 (env 세션) → 저장 함수 연결");
    let firstHash = "";
    {
      resetState();
      const t = await token({});
      const r = await call(sess(t));
      assert(r.status === 200, "env admin → 200");
      assert(r.body?.ok === true && r.body?.status === "APPLIED", "body ok/APPLIED");
      assert(r.body?.duplicate === false && r.body?.replaced === false, "not duplicate, not replaced");
      assert(r.body?.auditId === 1000, "auditId comes from storage (audit.create)");
      assert(r.body?.date === DATE, "body date");
      const counts = r.body?.counts as Record<string, number> | undefined;
      assert(
        counts?.schedules === 2 && counts?.shiftDuties === 2 && counts?.extraTags === 1,
        "body counts 2/2/1"
      );
      assert(
        typeof r.body?.payloadHash === "string" && (r.body.payloadHash as string).length > 0,
        "payloadHash present"
      );
      firstHash = String(r.body?.payloadHash ?? "");
      assert(!ops().includes("user.findUnique"), "env admin: no user lookup (env-only path)");
      checkStorageCalls("env admin", { replace: false });

      // 같은 요청 다시 → 중복 처리 (저장 안 함)
      state.calls = [];
      const again = await call(sess(t));
      assert(again.status === 200 && again.body?.duplicate === true, "same payload again → duplicate:true");
      assert(again.body?.auditId === 1000, "duplicate points to first audit");
      assert(again.body?.payloadHash === firstHash, "duplicate payloadHash matches");
      assert(!ops().includes("$transaction"), "duplicate: no transaction / no write");
    }

    section("정상 관리자 (DB 사용자 세션) → 저장 함수 연결");
    {
      resetState();
      state.users.set(501, { ...dbAdmin });
      const t = await token({ userId: 501, username: "boss", sv: 3 });
      const r = await call(sess(t));
      assert(r.status === 200 && r.body?.status === "APPLIED", "DB admin (sv match) → 200 APPLIED");
      assert(ops()[0] === "user.findUnique", "auth lookup happens before storage");
      checkStorageCalls("db admin", { replace: false });
    }

    // ── 5. 충돌 / replace / 검증 실패 / 트랜잭션 실패 ──
    section("충돌·replace·검증·오류 응답");
    const adminCookie = sess(await token({}));
    {
      resetState();
      state.existing = { schedules: 3, shiftDuties: 2, extraTags: 0 };
      const r = await call(adminCookie);
      assert(r.status === 409, "existing placements without replace → 409");
      assert(r.body?.code === "EXISTING_PLACEMENTS" && r.body?.requireReplace === true, "409 code + requireReplace");
      const ex = r.body?.existing as Record<string, number> | undefined;
      assert(ex?.schedules === 3 && ex?.shiftDuties === 2, "409 reports existing counts");
      assert(!ops().includes("$transaction"), "409: nothing written");
    }
    {
      resetState();
      state.existing = { schedules: 3, shiftDuties: 2, extraTags: 0 };
      const r = await call(adminCookie, confirmBody({ replace: true }));
      assert(r.status === 200 && r.body?.replaced === true, "replace:true → 200 replaced");
      checkStorageCalls("replace", { replace: true });
    }
    {
      resetState();
      const r = await call(adminCookie, confirmBody({ status: "DRAFT" }));
      assert(r.status === 400 && r.body?.code === "STATUS_NOT_CONFIRMED", "DRAFT → 400");
      assert(state.calls.length === 0, "DRAFT: no DB call");
    }
    {
      resetState();
      state.caddies = state.caddies.filter((c) => c.id !== 12);
      const r = await call(adminCookie);
      assert(r.status === 400 && r.body?.code === "UNKNOWN_CADDY", "unknown caddy → 400");
      assert(!ops().includes("$transaction"), "unknown caddy: nothing written");
    }
    {
      resetState();
      state.caddies = state.caddies.map((c) => (c.id === 12 ? { ...c, employmentStatus: "RETIRED" } : c));
      const r = await call(adminCookie);
      assert(r.status === 400 && typeof r.body?.code === "string" && r.body.code !== "UNKNOWN_CADDY", "retired caddy → 400");
      assert(!ops().includes("$transaction"), "retired: nothing written");
    }
    {
      resetState();
      state.transactionThrows = true;
      const r = await call(adminCookie);
      assert(r.status === 500 && r.body?.code === "TRANSACTION_FAILED", "transaction error → 500 TRANSACTION_FAILED");
    }
  } finally {
    // ── 원상 복구 ──
    if (hadGlobalPrisma) g.prisma = savedGlobalPrisma;
    else delete g.prisma;
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
