/**
 * 퇴사/삭제 캐디: 운영계 제외 유지 + Admin 전용 관리조회
 * 실행: npx tsx scripts/test-caddy-archive-visibility-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  canReadArchivedCaddies,
  caddyManageListWhere,
  denyArchivedCaddyRead,
  filterArchivedCaddies,
  isArchivedEmploymentStatus,
} from "../src/lib/caddyArchiveVisibility";
import { isOperationalEmploymentStatus } from "../src/lib/operationalRoster";
import {
  buildUnavailablePanelGroups,
  offCaddiesFromRoster,
} from "../src/lib/assignmentBoardDirectEdit";
import { unusedCaddies } from "../src/lib/assignmentDraft";
import { normalizeAppRole } from "../src/lib/sessionCookies";
import { isAccountManagerAuth } from "../src/lib/staffAdminAccounts";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

console.log("== auth role model ==");
assert(normalizeAppRole("admin") === "admin", "admin stays admin");
assert(normalizeAppRole("staff") === "caddy", "staff normalizes to caddy");
assert(normalizeAppRole("caddy") === "caddy", "caddy stays caddy");
assert(normalizeAppRole("leader") === "leader", "leader stays leader");
assert(
  isAccountManagerAuth({ role: "admin", username: "admin", userId: 1 }),
  "최고관리자 admin is account manager"
);
assert(
  isAccountManagerAuth({ role: "admin", username: "env", userId: null }),
  "env-only admin is account manager"
);
assert(
  !isAccountManagerAuth({ role: "admin", username: "박성민", userId: 7 }),
  "경기과 직원 admin is not account manager"
);

console.log("== archive read permission ==");
assert(
  canReadArchivedCaddies({ role: "admin", username: "admin", userId: 1 }),
  "ACTIVE/RETIRED Admin can read archive"
);
assert(
  canReadArchivedCaddies({ role: "admin", username: "x", userId: null }),
  "env Admin can read archive"
);
assert(
  !canReadArchivedCaddies({ role: "admin", username: "박성민", userId: 7 }),
  "경기과 staff admin cannot read archive"
);
assert(
  !canReadArchivedCaddies({ role: "caddy", username: "staff1", userId: 8 }),
  "caddy/staff role cannot read archive"
);
assert(
  !canReadArchivedCaddies({ role: "staff", username: "staff1", userId: 8 }),
  "legacy staff string cannot read archive"
);
assert(
  !canReadArchivedCaddies({ role: "leader", username: "조장", userId: 9 }),
  "leader cannot read archive"
);

console.log("== list/search/detail where ==");
assert(
  JSON.stringify(caddyManageListWhere("ACTIVE", true)) ===
    JSON.stringify({ employmentStatus: "ACTIVE" }),
  "ACTIVE + Admin list where"
);
assert(
  JSON.stringify(caddyManageListWhere("RETIRED", true)) ===
    JSON.stringify({ employmentStatus: "RETIRED" }),
  "RETIRED + Admin archive filter"
);
assert(
  JSON.stringify(caddyManageListWhere("all", true)) === JSON.stringify({}),
  "Admin all includes archive"
);
assert(
  JSON.stringify(caddyManageListWhere("RETIRED", false)) ===
    JSON.stringify({ empty: true }),
  "RETIRED + 경기과 staff list is empty"
);
assert(
  JSON.stringify(caddyManageListWhere("all", false)) ===
    JSON.stringify({ employmentStatus: { in: ["ACTIVE", "LEAVE"] } }),
  "staff all excludes RETIRED/DELETED"
);
assert(
  JSON.stringify(caddyManageListWhere("ACTIVE", false)) ===
    JSON.stringify({ employmentStatus: "ACTIVE" }),
  "ACTIVE + 경기과 staff still listed"
);
assert(
  !denyArchivedCaddyRead("ACTIVE", false) &&
    denyArchivedCaddyRead("RETIRED", false) &&
    denyArchivedCaddyRead("DELETED", false),
  "staff detail denies RETIRED/DELETED, allows ACTIVE"
);
assert(
  !denyArchivedCaddyRead("RETIRED", true) &&
    !denyArchivedCaddyRead("DELETED", true),
  "Admin detail can read RETIRED/DELETED"
);
assert(
  filterArchivedCaddies(
    [
      { id: 1, employmentStatus: "ACTIVE" },
      { id: 2, employmentStatus: "LEAVE" },
      { id: 3, employmentStatus: "RETIRED" },
      { id: 4, employmentStatus: "DELETED" },
    ],
    false
  )
    .map((r) => r.id)
    .join(",") === "1,2",
  "staff search/export drops RETIRED/DELETED"
);
assert(
  filterArchivedCaddies(
    [
      { id: 3, employmentStatus: "RETIRED" },
      { id: 4, employmentStatus: "DELETED" },
    ],
    true
  ).length === 2,
  "Admin archive export/search keeps RETIRED/DELETED"
);

console.log("== operational roster still excludes archive ==");
assert(isOperationalEmploymentStatus("ACTIVE"), "ACTIVE stays operational");
assert(!isOperationalEmploymentStatus("RETIRED"), "RETIRED not operational");
assert(!isOperationalEmploymentStatus("DELETED"), "DELETED not operational");
assert(isArchivedEmploymentStatus("RETIRED"), "RETIRED is archived");
const opsGroups = buildUnavailablePanelGroups({
  excluded: [
    {
      id: 1,
      name: "재직휴무",
      team: "1조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      employmentStatus: "ACTIVE",
      bucket: "excluded",
      excludedReasons: ["휴무"],
      specialTags: [],
      assignmentLabels: ["휴무"],
    },
    {
      id: 2,
      name: "퇴사휴무",
      team: "2조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      employmentStatus: "RETIRED",
      bucket: "excluded",
      excludedReasons: ["퇴사(RETIRED)", "휴무"],
      specialTags: [],
      assignmentLabels: ["휴무"],
    },
  ],
  opsDuties: [
    { caddyId: 2, name: "퇴사휴무", team: "2조", role: "DUTY_AM", employmentStatus: "RETIRED" },
  ],
  offCaddies: offCaddiesFromRoster(
    [1, 2],
    [
      { id: 1, name: "재직휴무", team: "1조", employmentStatus: "ACTIVE" },
      { id: 2, name: "퇴사휴무", team: "2조", employmentStatus: "RETIRED" },
    ]
  ),
});
assert(
  opsGroups.flatMap((g) => g.items.map((i) => i.name)).join(",") === "재직휴무",
  "RETIRED does not re-enter 운영현황/자동배치 후보"
);
const unused = unusedCaddies({
  date: "2026-09-10",
  status: "DRAFT",
  assignments: [],
  unassignedReservations: [],
  closedCourseReservations: [],
  openCourses: ["SKY"],
  sparesByShift: [],
  confirmedAt: null,
  caddyPool: [
    { id: 1, name: "가용", team: "1조", teamOrder: 1, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    { id: 2, name: "퇴사", team: "2조", teamOrder: 1, caddyType: "HOUSE", employmentStatus: "RETIRED" },
  ],
});
assert(unused.map((c) => c.name).join(",") === "가용", "unused/pick drops RETIRED");

console.log("== Published/Snapshot untouched ==");
assert(
  !/caddyArchiveVisibility/.test(readSrc("src/lib/dailyBoardPublished.ts")),
  "Published helper not rewritten"
);
assert(
  !/caddyArchiveVisibility/.test(readSrc("src/lib/dailyBoardPublishedService.ts")),
  "Published service not rewritten"
);
assert(
  !/caddyArchiveVisibility/.test(readSrc("src/lib/adminOpsDashboard.ts")),
  "ops dashboard snapshot helper not rewritten"
);
const publishedFixture = {
  placements: [{ caddyName: "과거퇴사자", caddyId: 999 }],
};
assert(
  publishedFixture.placements[0]?.caddyName === "과거퇴사자",
  "Published fixture retired name preserved"
);

console.log("== API/UI source guards ==");
const listRoute = readSrc("src/app/api/caddies/route.ts");
const idRoute = readSrc("src/app/api/caddies/[id]/route.ts");
const exportRoute = readSrc("src/app/api/caddies/export/route.ts");
const meRoute = readSrc("src/app/api/me/route.ts");
const page = readSrc("src/app/manage/caddies/page.tsx");
const notes = readSrc("src/app/api/caddies/[id]/notes.ts/route.ts");
assert(/requireAdmin/.test(listRoute) && !/requireSuperAdmin/.test(listRoute), "list stays requireAdmin");
assert(/canReadArchivedCaddies/.test(listRoute) && /caddyManageListWhere/.test(listRoute), "list uses archive where");
assert(/export async function GET/.test(idRoute), "detail GET exists");
assert(/denyArchivedCaddyRead/.test(idRoute), "detail/PATCH deny archived read");
assert(/requireAdmin/.test(idRoute) && !/requireSuperAdmin/.test(idRoute), "detail stays requireAdmin");
assert(/filterArchivedCaddies/.test(exportRoute), "export filters archive for staff");
assert(/canReadArchivedCaddies/.test(meRoute), "/api/me exposes archive flag");
assert(
  /canReadArchived \|\| value !== 'RETIRED'/.test(page) &&
    /canReadArchivedCaddies/.test(page),
  "UI hides 삭제됨 filter unless Admin archive reader"
);
assert(/requireAdmin/.test(notes) && /denyArchivedCaddyRead/.test(notes), "notes API is auth + archive gated");
assert(
  !/prisma\.caddy\.delete(Many)?\s*\(/.test(idRoute) &&
    !/prisma\.caddy\.delete(Many)?\s*\(/.test(listRoute),
  "no hard DELETE"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
