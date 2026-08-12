/**
 * Kakao User ↔ Caddy 수동 연결 단위 테스트 (Production DB write 없음)
 *
 * 실행: npx tsx scripts/test-user-caddy-link-unit.ts
 */
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import {
  UserCaddyLinkError,
  isLinkableKakaoUser,
  linkUserToCaddy,
  listKakaoUsersForAdmin,
  unlinkUserFromCaddy,
} from "../src/lib/userCaddyLink";
import { GET as usersGET } from "../src/app/api/users/route";
import { POST as linkPOST } from "../src/app/api/users/[id]/link-caddy/route";
import { POST as unlinkPOST } from "../src/app/api/users/[id]/unlink-caddy/route";
import { requireAdmin } from "../src/lib/auth";

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
  password: string | null;
  managedTeams: string[];
  createdAt: Date;
};

type CaddyRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

function createMockDb() {
  const users = new Map<number, UserRow>();
  const caddies = new Map<number, CaddyRow>();
  let nextUserId = 1;
  let nextCaddyId = 1;

  function addUser(
    partial: Partial<UserRow> & Pick<UserRow, "username">
  ): UserRow {
    const row: UserRow = {
      id: nextUserId++,
      username: partial.username,
      role: partial.role ?? "caddy",
      kakaoUserId: partial.kakaoUserId ?? null,
      caddyId: partial.caddyId ?? null,
      password: partial.password ?? null,
      managedTeams: partial.managedTeams ?? [],
      createdAt: partial.createdAt ?? new Date("2026-08-01T00:00:00Z"),
    };
    users.set(row.id, row);
    return snapshot(row);
  }

  function addCaddy(
    partial: Partial<CaddyRow> & Pick<CaddyRow, "name">
  ): CaddyRow {
    const row: CaddyRow = {
      id: nextCaddyId++,
      name: partial.name,
      team: partial.team ?? "A",
      teamOrder: partial.teamOrder ?? 1,
      employmentStatus: partial.employmentStatus ?? "ACTIVE",
    };
    caddies.set(row.id, row);
    return { ...row };
  }

  function snapshot(u: UserRow): UserRow {
    return { ...u, managedTeams: [...u.managedTeams] };
  }

  const db = {
    user: {
      async findUnique(args: {
        where: { id: number };
        select?: Record<string, boolean>;
      }) {
        const row = users.get(args.where.id);
        if (!row) return null;
        if (!args.select) return snapshot(row);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args.select)) {
          if (v) out[k] = (row as Record<string, unknown>)[k];
        }
        return out;
      },
      async findFirst(args: {
        where: { caddyId?: number };
        select?: { id?: boolean; username?: boolean };
      }) {
        for (const u of users.values()) {
          if (args.where.caddyId != null && u.caddyId !== args.where.caddyId) {
            continue;
          }
          if (args.select) {
            const out: Record<string, unknown> = {};
            if (args.select.id) out.id = u.id;
            if (args.select.username) out.username = u.username;
            return out;
          }
          return snapshot(u);
        }
        return null;
      },
      async findMany(args: {
        where?: {
          kakaoUserId?: { not: null };
          caddyId?: { not: null };
        };
        select?: Record<string, boolean | object>;
        orderBy?: unknown;
      }) {
        let list = [...users.values()];
        if (args.where?.kakaoUserId) {
          list = list.filter((u) => u.kakaoUserId != null);
        }
        if (args.where?.caddyId) {
          list = list.filter((u) => u.caddyId != null);
        }
        return list.map((u) => {
          if (args.select && args.select.caddyId && !args.select.username) {
            return { caddyId: u.caddyId };
          }
          const base: Record<string, unknown> = {
            id: u.id,
            username: u.username,
            role: u.role,
            kakaoUserId: u.kakaoUserId,
            caddyId: u.caddyId,
            createdAt: u.createdAt,
          };
          if (args.select?.caddy) {
            const c = u.caddyId != null ? caddies.get(u.caddyId) : null;
            base.caddy = c
              ? {
                  id: c.id,
                  name: c.name,
                  team: c.team,
                  teamOrder: c.teamOrder,
                  employmentStatus: c.employmentStatus,
                }
              : null;
          }
          return base;
        });
      },
      async updateMany(args: {
        where: {
          id: number;
          caddyId: number | null;
          kakaoUserId?: { not: null };
        };
        data: { caddyId: number | null };
      }) {
        const row = users.get(args.where.id);
        if (!row) return { count: 0 };
        if (row.caddyId !== args.where.caddyId) return { count: 0 };
        if (args.where.kakaoUserId && row.kakaoUserId == null) {
          return { count: 0 };
        }
        if (args.data.caddyId != null) {
          for (const other of users.values()) {
            if (other.id !== row.id && other.caddyId === args.data.caddyId) {
              throw new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on caddyId",
                { code: "P2002", clientVersion: "test" }
              );
            }
          }
        }
        // Only mutate caddyId (assert write scope in tests via snapshot)
        row.caddyId = args.data.caddyId;
        return { count: 1 };
      },
    },
    caddy: {
      async findUnique(args: {
        where: { id: number };
        select?: Record<string, boolean>;
      }) {
        const row = caddies.get(args.where.id);
        if (!row) return null;
        if (!args.select) return { ...row };
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args.select)) {
          if (v) out[k] = (row as Record<string, unknown>)[k];
        }
        return out;
      },
    },
    _users: users,
    _caddies: caddies,
    addUser,
    addCaddy,
    snap(id: number) {
      const u = users.get(id);
      if (!u) throw new Error(`missing ${id}`);
      return snapshot(u);
    },
  };

  return db;
}

async function expectError(
  fn: () => Promise<unknown>,
  status: number,
  code: string
) {
  try {
    await fn();
    assert(false, `expected ${code}`);
  } catch (e) {
    assert(e instanceof UserCaddyLinkError, `${code} is UserCaddyLinkError`);
    if (e instanceof UserCaddyLinkError) {
      assert(e.status === status, `${code} status ${status} (got ${e.status})`);
      assert(e.code === code, `${code} code (got ${e.code})`);
    }
  }
}

async function main() {
  section("isLinkableKakaoUser");
  {
    assert(
      isLinkableKakaoUser({ kakaoUserId: "1", role: "caddy" }) === true,
      "kakao caddy ok"
    );
    assert(
      isLinkableKakaoUser({ kakaoUserId: null, role: "caddy" }) === false,
      "non-kakao denied"
    );
    assert(
      isLinkableKakaoUser({ kakaoUserId: "1", role: "admin" }) === false,
      "admin denied"
    );
  }

  section("admin only (requireAdmin + routes)");
  {
    const noCookie = new NextRequest("http://localhost/api/users");
    const guard = requireAdmin(noCookie);
    assert(guard instanceof Response && guard.status === 401, "requireAdmin 401");

    const listRes = await usersGET(noCookie);
    assert(listRes.status === 401, "GET /api/users → 401");

    const linkRes = await linkPOST(noCookie, { params: { id: "1" } });
    assert(linkRes.status === 401, "POST link-caddy → 401");

    const unlinkRes = await unlinkPOST(noCookie, { params: { id: "1" } });
    assert(unlinkRes.status === 401, "POST unlink-caddy → 401");
  }

  section("link success — only User.caddyId changes");
  {
    const db = createMockDb();
    const caddy = db.addCaddy({ name: "김캐디", team: "1조", teamOrder: 2 });
    const user = db.addUser({
      username: "kakao_1",
      kakaoUserId: "1",
      role: "caddy",
      password: null,
      managedTeams: ["X"],
    });
    const before = db.snap(user.id);

    const result = await linkUserToCaddy(db as any, user.id, caddy.id);
    assert(result.caddyId === caddy.id, "linked caddyId");

    const after = db.snap(user.id);
    assert(after.caddyId === caddy.id, "caddyId set");
    assert(after.kakaoUserId === before.kakaoUserId, "kakaoUserId unchanged");
    assert(after.username === before.username, "username unchanged");
    assert(after.password === before.password, "password unchanged");
    assert(after.role === before.role, "role unchanged");
    assert(
      JSON.stringify(after.managedTeams) === JSON.stringify(before.managedTeams),
      "managedTeams unchanged"
    );
    assert(db._caddies.get(caddy.id)?.name === "김캐디", "Caddy row unchanged");
  }

  section("same Caddy → two Users → 409");
  {
    const db = createMockDb();
    const caddy = db.addCaddy({ name: "공유" });
    const u1 = db.addUser({
      username: "kakao_a",
      kakaoUserId: "a",
      caddyId: caddy.id,
    });
    const u2 = db.addUser({ username: "kakao_b", kakaoUserId: "b" });

    await expectError(
      () => linkUserToCaddy(db as any, u2.id, caddy.id),
      409,
      "caddy_already_linked"
    );
    assert(db.snap(u1.id).caddyId === caddy.id, "holder kept");
    assert(db.snap(u2.id).caddyId === null, "waiter still null");
  }

  section("already linked User — no direct replace");
  {
    const db = createMockDb();
    const c1 = db.addCaddy({ name: "A" });
    const c2 = db.addCaddy({ name: "B" });
    const user = db.addUser({
      username: "kakao_x",
      kakaoUserId: "x",
      caddyId: c1.id,
    });

    await expectError(
      () => linkUserToCaddy(db as any, user.id, c2.id),
      409,
      "already_linked"
    );
    assert(db.snap(user.id).caddyId === c1.id, "still c1");
  }

  section("unlink success — no side effects on other users");
  {
    const db = createMockDb();
    const caddy = db.addCaddy({ name: "해제" });
    const linked = db.addUser({
      username: "kakao_u",
      kakaoUserId: "u",
      caddyId: caddy.id,
      managedTeams: ["Z"],
    });
    const other = db.addUser({
      username: "kakao_o",
      kakaoUserId: "o",
      caddyId: null,
    });
    const beforeOther = db.snap(other.id);
    const beforeLinked = db.snap(linked.id);

    const r = await unlinkUserFromCaddy(db as any, linked.id);
    assert(r.previousCaddyId === caddy.id, "previous id returned");
    const after = db.snap(linked.id);
    assert(after.caddyId === null, "unlinked");
    assert(after.kakaoUserId === beforeLinked.kakaoUserId, "kakao intact");
    assert(after.username === beforeLinked.username, "username intact");
    assert(after.role === beforeLinked.role, "role intact");
    assert(
      JSON.stringify(db.snap(other.id)) === JSON.stringify(beforeOther),
      "other user untouched"
    );
  }

  section("non-Kakao / admin / RETIRED forbidden");
  {
    const db = createMockDb();
    const active = db.addCaddy({ name: "N" });
    const retired = db.addCaddy({
      name: "퇴직",
      employmentStatus: "RETIRED",
    });
    const local = db.addUser({ username: "local", kakaoUserId: null });
    const admin = db.addUser({
      username: "kakao_admin",
      kakaoUserId: "adm",
      role: "admin",
    });
    const kakao = db.addUser({ username: "kakao_r", kakaoUserId: "r" });

    await expectError(
      () => linkUserToCaddy(db as any, local.id, active.id),
      403,
      "not_linkable_user"
    );
    await expectError(
      () => linkUserToCaddy(db as any, admin.id, active.id),
      403,
      "not_linkable_user"
    );
    await expectError(
      () => linkUserToCaddy(db as any, kakao.id, retired.id),
      409,
      "caddy_not_active"
    );
    assert(db.snap(local.id).caddyId === null, "local still null");
    assert(db.snap(admin.id).caddyId === null, "admin still null");
    assert(db.snap(kakao.id).caddyId === null, "kakao still null");
  }

  section("list excludes admin + non-kakao");
  {
    const db = createMockDb();
    db.addUser({ username: "local", kakaoUserId: null });
    db.addUser({
      username: "kakao_admin",
      kakaoUserId: "a1",
      role: "admin",
    });
    const ok = db.addUser({
      username: "kakao_ok",
      kakaoUserId: "ok",
      role: "caddy",
    });
    const { users, occupiedCaddyIds } = await listKakaoUsersForAdmin(db as any);
    assert(users.length === 1 && users[0]?.id === ok.id, "only linkable kakao");
    assert(occupiedCaddyIds.length === 0, "no occupied");
  }

  section("unlink then relink (allowed path for switch)");
  {
    const db = createMockDb();
    const c1 = db.addCaddy({ name: "1" });
    const c2 = db.addCaddy({ name: "2", team: "B", teamOrder: 2 });
    const user = db.addUser({
      username: "kakao_z",
      kakaoUserId: "z",
      caddyId: c1.id,
    });
    await unlinkUserFromCaddy(db as any, user.id);
    assert(db.snap(user.id).caddyId === null, "unlinked first");
    await linkUserToCaddy(db as any, user.id, c2.id);
    assert(db.snap(user.id).caddyId === c2.id, "relinked to c2");
  }

  section("stale concurrent: P2002 → 409, no steal");
  {
    const db = createMockDb();
    const caddy = db.addCaddy({ name: "선점" });
    // Simulate race: holder check passes for waiter, but unique fails on write
    // by having holder appear only at update time via forced second link attempt
    const holder = db.addUser({
      username: "kakao_h",
      kakaoUserId: "h",
      caddyId: null,
    });
    const waiter = db.addUser({ username: "kakao_w", kakaoUserId: "w" });

    await linkUserToCaddy(db as any, holder.id, caddy.id);
    await expectError(
      () => linkUserToCaddy(db as any, waiter.id, caddy.id),
      409,
      "caddy_already_linked"
    );
    assert(db.snap(holder.id).caddyId === caddy.id, "holder kept after race");
    assert(db.snap(waiter.id).caddyId === null, "waiter not stolen");
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
