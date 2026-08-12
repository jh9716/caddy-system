/**
 * CaddyLinkRequest domain unit tests (Production DB write 없음)
 * 실행: npx tsx scripts/test-caddy-link-request-api-unit.ts
 */
import { Prisma } from "@prisma/client";
import {
  CaddyLinkRequestError,
  approveCaddyLinkRequest,
  cancelCaddyLinkRequest,
  getMineCaddyLinkRequest,
  listPendingCaddyLinkRequests,
  rejectCaddyLinkRequest,
  submitCaddyLinkRequest,
} from "../src/lib/caddyLinkRequest";
import { linkUserToCaddy } from "../src/lib/userCaddyLink";

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

type UserRow = {
  id: number;
  username: string;
  role: string;
  kakaoUserId: string | null;
  caddyId: number | null;
};

type CaddyRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  phoneNormalized: string | null;
};

type ReqRow = {
  id: number;
  userId: number;
  submittedName: string;
  phoneNormalized: string;
  candidateCaddyIds: number[];
  selectedCaddyId: number | null;
  status: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByUserId: number | null;
  decisionNote: string | null;
};

function createMockDb() {
  const users = new Map<number, UserRow>();
  const caddies = new Map<number, CaddyRow>();
  const reqs = new Map<number, ReqRow>();
  let nextUser = 1;
  let nextCaddy = 1;
  let nextReq = 1;

  const db: any = {
    user: {
      async findUnique({ where, select }: any) {
        const row = users.get(where.id);
        if (!row) return null;
        if (!select) return { ...row };
        const out: any = {};
        for (const [k, v] of Object.entries(select)) if (v) out[k] = (row as any)[k];
        return out;
      },
      async findFirst({ where, select }: any) {
        for (const u of users.values()) {
          if (where.caddyId != null && u.caddyId !== where.caddyId) continue;
          if (!select) return { ...u };
          const out: any = {};
          for (const [k, v] of Object.entries(select)) if (v) out[k] = (u as any)[k];
          return out;
        }
        return null;
      },
      async updateMany({ where, data }: any) {
        const row = users.get(where.id);
        if (!row) return { count: 0 };
        if (where.caddyId !== undefined && row.caddyId !== where.caddyId) {
          return { count: 0 };
        }
        if (where.kakaoUserId?.not === null && row.kakaoUserId == null) {
          return { count: 0 };
        }
        if (data.caddyId != null) {
          for (const o of users.values()) {
            if (o.id !== row.id && o.caddyId === data.caddyId) {
              throw new Prisma.PrismaClientKnownRequestError("P2002 caddyId", {
                code: "P2002",
                clientVersion: "test",
                meta: { target: ["caddyId"] },
              });
            }
          }
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    caddy: {
      async findMany({ where, select }: any) {
        let list = [...caddies.values()];
        if (where?.employmentStatus) {
          list = list.filter((c) => c.employmentStatus === where.employmentStatus);
        }
        if (where?.id?.in) {
          list = list.filter((c) => where.id.in.includes(c.id));
        }
        return list.map((c) => {
          if (!select) return { ...c };
          const out: any = {};
          for (const [k, v] of Object.entries(select)) if (v) out[k] = (c as any)[k];
          return out;
        });
      },
      async findUnique({ where, select }: any) {
        const row = caddies.get(where.id);
        if (!row) return null;
        if (!select) return { ...row };
        const out: any = {};
        for (const [k, v] of Object.entries(select)) if (v) out[k] = (row as any)[k];
        return out;
      },
      async findFirst({ where, select }: any) {
        for (const c of caddies.values()) {
          if (
            where.phoneNormalized != null &&
            c.phoneNormalized !== where.phoneNormalized
          ) {
            continue;
          }
          if (where.NOT?.id != null && c.id === where.NOT.id) continue;
          if (!select) return { ...c };
          const out: any = {};
          for (const [k, v] of Object.entries(select)) if (v) out[k] = (c as any)[k];
          return out;
        }
        return null;
      },
      async update({ where, data }: any) {
        const row = caddies.get(where.id);
        if (!row) throw new Error("missing caddy");
        if (data.phoneNormalized != null) {
          for (const o of caddies.values()) {
            if (o.id !== row.id && o.phoneNormalized === data.phoneNormalized) {
              throw new Prisma.PrismaClientKnownRequestError("P2002 phone", {
                code: "P2002",
                clientVersion: "test",
                meta: { target: ["phoneNormalized"] },
              });
            }
          }
        }
        Object.assign(row, data);
        return { ...row };
      },
    },
    caddyLinkRequest: {
      async create({ data, select }: any) {
        for (const r of reqs.values()) {
          if (r.userId === data.userId && r.status === "PENDING") {
            throw new Prisma.PrismaClientKnownRequestError("P2002 pending", {
              code: "P2002",
              clientVersion: "test",
              meta: { target: ["userId"] },
            });
          }
        }
        const row: ReqRow = {
          id: nextReq++,
          userId: data.userId,
          submittedName: data.submittedName,
          phoneNormalized: data.phoneNormalized,
          candidateCaddyIds: [...(data.candidateCaddyIds ?? [])],
          selectedCaddyId: data.selectedCaddyId ?? null,
          status: data.status ?? "PENDING",
          requestedAt: new Date(),
          decidedAt: data.decidedAt ?? null,
          decidedByUserId: data.decidedByUserId ?? null,
          decisionNote: data.decisionNote ?? null,
        };
        reqs.set(row.id, row);
        if (!select) return { ...row, candidateCaddyIds: [...row.candidateCaddyIds] };
        const out: any = {};
        for (const [k, v] of Object.entries(select)) {
          if (v) out[k] = (row as any)[k];
        }
        return out;
      },
      async findUnique({ where, select }: any) {
        const row = reqs.get(where.id);
        if (!row) return null;
        return projectReq(row, select);
      },
      async findUniqueOrThrow({ where, select }: any) {
        const row = reqs.get(where.id);
        if (!row) throw new Error("not found");
        return projectReq(row, select);
      },
      async findFirst({ where, orderBy, select }: any) {
        let list = [...reqs.values()];
        if (where?.userId != null) list = list.filter((r) => r.userId === where.userId);
        if (where?.status != null) list = list.filter((r) => r.status === where.status);
        if (orderBy) {
          list.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id - a.id);
        }
        const row = list[0];
        if (!row) return null;
        return projectReq(row, select);
      },
      async findMany({ where, orderBy, select }: any) {
        let list = [...reqs.values()];
        if (where?.status) list = list.filter((r) => r.status === where.status);
        if (orderBy) {
          list.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id - b.id);
        }
        return list.map((r) => {
          const base = projectReq(r, select);
          if (select?.user) {
            const u = users.get(r.userId)!;
            (base as any).user = {
              id: u.id,
              username: u.username,
              kakaoUserId: u.kakaoUserId,
            };
          }
          return base;
        });
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const r of reqs.values()) {
          if (where.id != null && r.id !== where.id) continue;
          if (where.userId != null && r.userId !== where.userId) continue;
          if (where.status != null && r.status !== where.status) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
    async $transaction(fn: any) {
      // simple: no nested rollback simulation beyond throw
      return fn(db);
    },
    addUser(partial: Partial<UserRow> & { username: string }) {
      const row: UserRow = {
        id: nextUser++,
        username: partial.username,
        role: partial.role ?? "caddy",
        kakaoUserId: partial.kakaoUserId ?? null,
        caddyId: partial.caddyId ?? null,
      };
      users.set(row.id, row);
      return { ...row };
    },
    addCaddy(partial: Partial<CaddyRow> & { name: string }) {
      const row: CaddyRow = {
        id: nextCaddy++,
        name: partial.name,
        team: partial.team ?? "1조",
        teamOrder: partial.teamOrder ?? 1,
        employmentStatus: partial.employmentStatus ?? "ACTIVE",
        phoneNormalized: partial.phoneNormalized ?? null,
      };
      caddies.set(row.id, row);
      return { ...row };
    },
    _users: users,
    _caddies: caddies,
    _reqs: reqs,
  };

  function projectReq(row: ReqRow, select?: any) {
    if (!select) return { ...row, candidateCaddyIds: [...row.candidateCaddyIds] };
    const out: any = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v || k === "user") continue;
      out[k] =
        k === "candidateCaddyIds"
          ? [...row.candidateCaddyIds]
          : (row as any)[k];
    }
    return out;
  }

  return db;
}

async function expectCode(fn: () => Promise<unknown>, code: string, status?: number) {
  try {
    await fn();
    assert(false, `expected ${code}`);
  } catch (e) {
    assert(e instanceof CaddyLinkRequestError, `${code} type`);
    if (e instanceof CaddyLinkRequestError) {
      assert(e.code === code, `${code} code (got ${e.code})`);
      if (status != null) assert(e.status === status, `${code} status ${status}`);
    }
  }
}

async function main() {
  section("submit success / no_candidates / homonyms");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "kakao_1", kakaoUserId: "101" });
    db.addCaddy({ name: "이영진", team: "1조", teamOrder: 2 });
    const ok = await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "010-1111-2222",
    });
    assert(ok.status === "PENDING", "submit PENDING");
    assert(ok.maskedPhone === "010-****-2222", "staff masked");
    assert(!(ok as any).candidateCaddyIds, "staff no candidates");
    assert(!(ok as any).phoneNormalized, "staff no raw phone");
    assert(db._users.get(u.id)!.caddyId == null, "submit no User.caddyId write");
    const c0 = [...db._caddies.values()][0];
    assert(c0.phoneNormalized == null, "submit no Caddy.phone write");
    const stored = [...db._reqs.values()][0];
    assert(stored.phoneNormalized === "01011112222", "DB stores normalized");
    assert(stored.candidateCaddyIds.length === 1, "1 candidate stored");

    await expectCode(
      () =>
        submitCaddyLinkRequest(db, u.id, {
          name: "없는사람",
          phone: "01033334444",
        }),
      "pending_exists",
      409
    );

    // cancel then no_candidates
    await cancelCaddyLinkRequest(db, u.id, ok.id);
    await expectCode(
      () =>
        submitCaddyLinkRequest(db, u.id, {
          name: "없는사람",
          phone: "01033334444",
        }),
      "no_candidates",
      404
    );

    // homonyms
    db.addCaddy({ name: "김현정", team: "2조", teamOrder: 1 });
    db.addCaddy({ name: "김현정", team: "5조", teamOrder: 3 });
    const multi = await submitCaddyLinkRequest(db, u.id, {
      name: "김현정",
      phone: "01055556666",
    });
    const multiRow = db._reqs.get(multi.id)!;
    assert(multiRow.candidateCaddyIds.length === 2, "N candidates stored");
    assert(!(multi as any).candidates, "staff response hides candidates");
  }

  section("submit guards");
  {
    const db = createMockDb();
    const admin = db.addUser({
      username: "admin",
      role: "admin",
      kakaoUserId: "9",
    });
    const nonKakao = db.addUser({
      username: "pw",
      role: "caddy",
      kakaoUserId: null,
    });
    const c = db.addCaddy({ name: "테스트" });
    const linked = db.addUser({
      username: "linked",
      kakaoUserId: "8",
      caddyId: c.id,
    });

    await expectCode(
      () =>
        submitCaddyLinkRequest(db, admin.id, {
          name: "테스트",
          phone: "01011112222",
        }),
      "not_linkable_user",
      403
    );
    await expectCode(
      () =>
        submitCaddyLinkRequest(db, nonKakao.id, {
          name: "테스트",
          phone: "01011112222",
        }),
      "not_linkable_user",
      403
    );
    await expectCode(
      () =>
        submitCaddyLinkRequest(db, linked.id, {
          name: "테스트",
          phone: "01011112222",
        }),
      "already_linked",
      409
    );
  }

  section("cancel ownership / terminal");
  {
    const db = createMockDb();
    const a = db.addUser({ username: "a", kakaoUserId: "1" });
    const b = db.addUser({ username: "b", kakaoUserId: "2" });
    db.addCaddy({ name: "이영진" });
    const req = await submitCaddyLinkRequest(db, a.id, {
      name: "이영진",
      phone: "01011112222",
    });
    await expectCode(
      () => cancelCaddyLinkRequest(db, b.id, req.id),
      "forbidden",
      403
    );
    const cancelled = await cancelCaddyLinkRequest(db, a.id, req.id);
    assert(cancelled.status === "CANCELLED", "cancel ok");
    await expectCode(
      () => cancelCaddyLinkRequest(db, a.id, req.id),
      "not_pending",
      409
    );
  }

  section("admin list masking");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "kakao_u", kakaoUserId: "55" });
    db.addCaddy({ name: "이영진", team: "3조", teamOrder: 4 });
    await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "01099998888",
    });
    const list = await listPendingCaddyLinkRequests(db);
    assert(list.length === 1, "1 pending");
    assert(list[0].maskedPhone === "010-****-8888", "admin masked");
    assert(!(list[0] as any).phoneNormalized, "admin list no raw");
    assert(list[0].candidates[0].team === "3조", "admin sees team");
    assert(list[0].user.username === "kakao_u", "admin sees username");
  }

  section("approve happy path + guards");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "k", kakaoUserId: "7" });
    const c1 = db.addCaddy({ name: "이영진", team: "1조", teamOrder: 1 });
    const c2 = db.addCaddy({ name: "이영진", team: "2조", teamOrder: 2 });
    const retired = db.addCaddy({
      name: "이영진",
      team: "9조",
      employmentStatus: "RETIRED",
    });
    const req = await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "010-1234-5678",
    });
    // retired not in candidates (ACTIVE only at submit)
    assert(!db._reqs.get(req.id)!.candidateCaddyIds.includes(retired.id), "no retired candidate");

    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, 99999, 1),
      "caddy_not_in_candidates",
      400
    );

    const ok = await approveCaddyLinkRequest(db, req.id, c1.id, 99);
    assert(ok.status === "APPROVED", "approved");
    assert(db._users.get(u.id)!.caddyId === c1.id, "User.caddyId set");
    assert(db._caddies.get(c1.id)!.phoneNormalized === "01012345678", "phone set");
    assert(db._reqs.get(req.id)!.status === "APPROVED", "req APPROVED");
    assert(db._reqs.get(req.id)!.selectedCaddyId === c1.id, "selected set");

    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, c2.id, 99),
      "not_pending",
      409
    );
  }

  section("approve conflicts / same phone ok / rollback");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "k2", kakaoUserId: "22" });
    const holder = db.addUser({ username: "holder", kakaoUserId: "33" });
    const c = db.addCaddy({ name: "박서진", team: "1조" });
    const other = db.addCaddy({
      name: "다른이",
      team: "2조",
      phoneNormalized: "01077776666",
    });
    holder.caddyId = c.id;
    db._users.set(holder.id, holder);

    const req = await submitCaddyLinkRequest(db, u.id, {
      name: "박서진",
      phone: "010-7777-6666",
    });
    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, c.id, 1),
      "caddy_already_linked",
      409
    );
    assert(db._users.get(u.id)!.caddyId == null, "rollback: user still null");
    assert(db._reqs.get(req.id)!.status === "PENDING", "rollback: still PENDING");

    // free caddy, phone duplicate on other
    holder.caddyId = null;
    db._users.set(holder.id, holder);
    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, c.id, 1),
      "phone_duplicate",
      409
    );

    // phone conflict on selected
    other.phoneNormalized = "01000001111";
    db._caddies.set(other.id, other);
    c.phoneNormalized = "01099990000";
    db._caddies.set(c.id, c);
    const req2user = db.addUser({ username: "k3", kakaoUserId: "44" });
    // cancel pending first for u
    await cancelCaddyLinkRequest(db, u.id, req.id);
    const req2 = await submitCaddyLinkRequest(db, req2user.id, {
      name: "박서진",
      phone: "010-1111-0000",
    });
    await expectCode(
      () => approveCaddyLinkRequest(db, req2.id, c.id, 1),
      "phone_conflict",
      409
    );

    // same phone already on caddy → allow
    c.phoneNormalized = "01011110000";
    db._caddies.set(c.id, c);
    const ok = await approveCaddyLinkRequest(db, req2.id, c.id, 1);
    assert(ok.status === "APPROVED", "same phone approve");
    assert(db._caddies.get(c.id)!.phoneNormalized === "01011110000", "phone unchanged when same");
  }

  section("retired at approve time");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "kr", kakaoUserId: "77" });
    const c = db.addCaddy({ name: "최유지", team: "1조" });
    const req = await submitCaddyLinkRequest(db, u.id, {
      name: "최유지",
      phone: "01022223333",
    });
    c.employmentStatus = "RETIRED";
    db._caddies.set(c.id, c);
    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, c.id, 1),
      "caddy_not_active",
      409
    );
  }

  section("reject + reapprove forbidden");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "kj", kakaoUserId: "88" });
    const c = db.addCaddy({ name: "이영진" });
    const req = await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "01033334444",
    });
    const rej = await rejectCaddyLinkRequest(db, req.id, 1, "오타");
    assert(rej.status === "REJECTED", "rejected");
    assert(db._users.get(u.id)!.caddyId == null, "reject no user write");
    assert(db._caddies.get(c.id)!.phoneNormalized == null, "reject no phone write");
    await expectCode(
      () => approveCaddyLinkRequest(db, req.id, c.id, 1),
      "not_pending",
      409
    );
  }

  section("manual link cancels PENDING + no phone write");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "km", kakaoUserId: "66" });
    const c = db.addCaddy({
      name: "이영진",
      phoneNormalized: "01055550000",
    });
    const req = await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "010-9999-8888",
    });
    await linkUserToCaddy(db, u.id, c.id);
    assert(db._users.get(u.id)!.caddyId === c.id, "manual linked");
    assert(db._reqs.get(req.id)!.status === "CANCELLED", "PENDING cancelled");
    assert(
      db._reqs.get(req.id)!.decisionNote === "superseded_by_manual_link",
      "manual cancel note"
    );
    assert(
      db._caddies.get(c.id)!.phoneNormalized === "01055550000",
      "manual link does not change phone"
    );
  }

  section("mine");
  {
    const db = createMockDb();
    const u = db.addUser({ username: "mine", kakaoUserId: "12" });
    assert((await getMineCaddyLinkRequest(db, u.id)) === null, "mine empty");
    db.addCaddy({ name: "이영진" });
    await submitCaddyLinkRequest(db, u.id, {
      name: "이영진",
      phone: "01011112222",
    });
    const mine = await getMineCaddyLinkRequest(db, u.id);
    assert(mine?.status === "PENDING", "mine pending");
    assert(mine?.maskedPhone === "010-****-2222", "mine masked");
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
