/**
 * OffRequest 권한 헬퍼 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-off-request-auth-unit.ts
 */
import {
  canAccessTeam,
  canManageOffRequests,
  canSubmitOwnOffRequest,
  isOwnCaddy,
  normalizeTeamName,
  resolveTeamFilter,
  uniqueTeams,
  type OffRequestActor,
} from "../src/lib/offRequestAuth";

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

function actor(partial: Partial<OffRequestActor> & Pick<OffRequestActor, "role">): OffRequestActor {
  return {
    username: partial.username ?? "u",
    userId: partial.userId ?? null,
    caddyId: partial.caddyId ?? null,
    managedTeams: partial.managedTeams ?? [],
    role: partial.role,
  };
}

section("uniqueTeams / normalize");
{
  assert(normalizeTeamName(" 1조 ") === "1조", "trim team");
  assert(
    uniqueTeams(["1조", "1조", " 2조 ", "", null]).join(",") === "1조,2조",
    "dedupe teams"
  );
}

section("canManage / canSubmit");
{
  assert(canManageOffRequests(actor({ role: "admin" })), "admin manage");
  assert(canManageOffRequests(actor({ role: "leader", managedTeams: ["1조"] })), "leader manage");
  assert(!canManageOffRequests(actor({ role: "caddy", caddyId: 1 })), "caddy no manage");
  assert(canSubmitOwnOffRequest(actor({ role: "caddy", caddyId: 10 })), "caddy submit");
  assert(canSubmitOwnOffRequest(actor({ role: "leader", caddyId: 10, managedTeams: ["1조"] })), "leader+caddy submit");
  assert(!canSubmitOwnOffRequest(actor({ role: "caddy", caddyId: null })), "no caddyId no submit");
  assert(isOwnCaddy(actor({ role: "caddy", caddyId: 3 }), 3), "own");
  assert(!isOwnCaddy(actor({ role: "caddy", caddyId: 3 }), 4), "not own");
}

section("canAccessTeam — multi-team leader, no 1:1 force");
{
  const leader = actor({ role: "leader", managedTeams: ["1조", "3조"] });
  assert(canAccessTeam(leader, "1조"), "leader team 1");
  assert(canAccessTeam(leader, "3조"), "leader team 3");
  assert(!canAccessTeam(leader, "2조"), "leader other team denied");
  assert(canAccessTeam(actor({ role: "admin" }), "99조"), "admin any team");
  assert(!canAccessTeam(actor({ role: "caddy", caddyId: 1 }), "1조"), "caddy no team manage");
  // 공동 조장: 같은 조를 여러 leader가 가질 수 있음(데이터 모델 제약 없음)
  const co1 = actor({ role: "leader", userId: 1, managedTeams: ["2조"] });
  const co2 = actor({ role: "leader", userId: 2, managedTeams: ["2조", "4조"] });
  assert(canAccessTeam(co1, "2조") && canAccessTeam(co2, "2조"), "co-leaders same team");
}

section("resolveTeamFilter");
{
  const admin = actor({ role: "admin" });
  assert(resolveTeamFilter(admin).ok && resolveTeamFilter(admin).ok && (resolveTeamFilter(admin) as any).teams === null, "admin all");
  const a1 = resolveTeamFilter(admin, "1조");
  assert(a1.ok && a1.ok && a1.teams?.join() === "1조", "admin filter team");

  const leader = actor({ role: "leader", managedTeams: ["1조", "2조"] });
  const l0 = resolveTeamFilter(leader);
  assert(l0.ok && l0.teams?.join() === "1조,2조", "leader default managed");
  const l1 = resolveTeamFilter(leader, "2조");
  assert(l1.ok && l1.teams?.join() === "2조", "leader subset");
  const lBad = resolveTeamFilter(leader, "9조");
  assert(!lBad.ok && !lBad.ok && (lBad as any).error === "team_forbidden", "leader forbidden team");

  const empty = actor({ role: "leader", managedTeams: [] });
  const e0 = resolveTeamFilter(empty);
  assert(!e0.ok && (e0 as any).error === "no_managed_teams", "leader without teams");

  const caddy = actor({ role: "caddy", caddyId: 1 });
  assert(!resolveTeamFilter(caddy).ok, "caddy filter forbidden");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
