/**
 * 캐디 현장표(엑셀형) 헬퍼 단위 테스트
 * 실행: npx tsx scripts/test-caddy-roster-board-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DRIVING_POOL_TEAM } from "../src/lib/caddyManage";
import {
  ROSTER_FIELD_COLOR_POLICY,
  ROSTER_HOUSE_LABEL,
  ROSTER_THIRD_LABEL,
  buildRosterColumns,
  buildRosterTeamSummaries,
  listMobileRosterRows,
  normalizeMobileRosterKey,
  ownedCartNumberByCaddyId,
  rosterPersonName,
  rosterQueryMatches,
  rosterSubgroupLabel,
} from "../src/lib/caddyRosterBoard";

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

const rows = [
  {
    id: 1,
    name: "김하우스",
    team: "1조",
    teamOrder: 2,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
  },
  {
    id: 2,
    name: "이휴직",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "LEAVE",
    caddyType: "HOUSE",
  },
  {
    id: 3,
    name: "박삭제",
    team: "1조",
    teamOrder: 3,
    employmentStatus: "RETIRED",
    caddyType: "HOUSE",
  },
  {
    id: 4,
    name: "최3부",
    team: "9조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKDAY" as const,
  },
  {
    id: 5,
    name: "정드라이브",
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    employmentStatus: "ACTIVE",
    caddyType: "DRIVING",
  },
];

console.log("== roster columns ==");
{
  const cols = buildRosterColumns({ rows });
  const one = cols.find((c) => c.key === "1조")!;
  const nine = cols.find((c) => c.key === "9조")!;
  const driving = cols.find((c) => c.key === DRIVING_POOL_TEAM)!;
  assert(cols.length === 13, "1~12조 + 드라이빙");
  assert(one.band === "HOUSE" && nine.band === "THIRD", "하우스/3부반 band");
  assert(one.count === 2, "RETIRED excluded from 1조 총원");
  assert(
    one.members.map((m) => m.id).join(",") === "2,1",
    "LEAVE stays; sort by teamOrder"
  );
  assert(
    !one.members.some((m) => m.id === 3),
    "RETIRED hidden from default roster"
  );
  assert(nine.members[0]?.id === 4, "3부반 member");
  assert(driving.driving && driving.members[0]?.id === 5, "driving column");
  assert(rosterSubgroupLabel("WEEKDAY") === "주중", "주중 라벨");
  assert(rosterSubgroupLabel("WEEKEND") === "주말", "주말 라벨");
  assert(rosterSubgroupLabel(null) === null, "일반은 배지 없음");
}

console.log("== search / mobile ==");
{
  const cols = buildRosterColumns({ rows, query: "3부" });
  assert(
    cols.find((c) => c.key === "1조")?.members.length === 0 &&
      cols.find((c) => c.key === "9조")?.members[0]?.name === "최3부",
    "search filters by name"
  );
  assert(rosterQueryMatches({ id: 12, name: "김" }, "12"), "id search");
  const mobileTeam = listMobileRosterRows({
    columns: buildRosterColumns({ rows }),
    selectedKey: "1조",
  });
  assert(
    mobileTeam.map((r) => r.id).join(",") === "2,1",
    "mobile selected team only"
  );
  const mobileSearch = listMobileRosterRows({
    columns: buildRosterColumns({ rows, query: "정" }),
    selectedKey: "1조",
    query: "정",
  });
  assert(
    mobileSearch.length === 1 && mobileSearch[0]?.columnTitle === "드라이빙",
    "mobile search looks across teams"
  );
  assert(normalizeMobileRosterKey("11조") === "11조", "valid team kept");
  assert(normalizeMobileRosterKey("99조") === "1조", "invalid team fallback");
}

console.log("== owned cart map ==");
{
  const map = ownedCartNumberByCaddyId([
    { ownerCaddyId: 1, number: "12", dormitoryOnly: false },
    { ownerCaddyId: 2, number: "99", dormitoryOnly: true },
    { ownerCaddyId: null, number: "7", dormitoryOnly: true },
    { ownerCaddyId: 4, number: "  ", dormitoryOnly: false },
  ]);
  assert(map[1] === "12", "owned cart mapped");
  assert(map[2] == null, "dormitory-only cart never shown as owned");
  assert(map[4] == null, "blank number ignored");
}

console.log("== summaries / names ==");
{
  const summaries = buildRosterTeamSummaries(rows);
  const one = summaries.find((s) => s.team === "1조")!;
  assert(one.active === 1 && one.leave === 1 && one.retired === 1, "status split");
  assert(one.total === 2, "총원 = ACTIVE+LEAVE");
  assert(rosterPersonName({ name: "  " }) === "이름없음", "empty name");
}

console.log("== no inferred colors / no batch API ==");
{
  assert(
    ROSTER_FIELD_COLOR_POLICY.leaderYellow === false &&
      ROSTER_FIELD_COLOR_POLICY.dormCartOrange === false &&
      ROSTER_FIELD_COLOR_POLICY.oneThreeApplicantBlue === false,
    "field colors stay off without roster SoT"
  );
  const lib = fs.readFileSync(
    path.resolve("src/lib/caddyRosterBoard.ts"),
    "utf8"
  );
  assert(lib.includes(ROSTER_HOUSE_LABEL) && lib.includes(ROSTER_THIRD_LABEL), "band labels");
  assert(
    !/isLeader|조장색|dormCartOrange\s*[:=]\s*true|oneThreeApplicantBlue\s*[:=]\s*true/.test(
      lib
    ),
    "no inferred color flags"
  );

  const idRoute = fs.readFileSync(
    path.resolve("src/app/api/caddies/[id]/route.ts"),
    "utf8"
  );
  const listRoute = fs.readFileSync(
    path.resolve("src/app/api/caddies/route.ts"),
    "utf8"
  );
  assert(
    idRoute.includes("swapWithId") &&
      !fs.existsSync(path.resolve("src/app/api/caddies/batch/route.ts")) &&
      !fs.existsSync(path.resolve("src/app/api/caddies/reorder/route.ts")),
    "no new batch/reorder API; pairwise swap remains"
  );
  assert(
    /prisma\.caddy\.update/.test(idRoute) && !/prisma\.caddy\.create/.test(idRoute),
    "PATCH keeps existing caddy id"
  );
  assert(!/prisma\.caddy\.delete(Many)?\s*\(/.test(idRoute), "no hard delete");
  assert(
    listRoute.includes("findMany") && !listRoute.includes("ownedCart"),
    "list API unchanged; cart numbers come from /api/carts"
  );
}

console.log("== page wiring ==");
{
  const page = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  assert(/className="cm-roster"/.test(page), "PC keeps horizontal roster");
  assert(/cm-roster-desktop/.test(page) && /cm-roster-mobile/.test(page), "responsive split");
  assert(/cm-team-chip/.test(page) && /setMobileTeam/.test(page), "mobile team picker");
  assert(/\/api\/carts/.test(page) && /ownedCartNumberByCaddyId/.test(page), "cart numbers from carts API");
  assert(/cm-cart/.test(page) && /rosterPersonName\(c\)/.test(page), "cart + name cells");
  assert(!/cm-cell-name[\s\S]{0,40}\{c\.id\}/.test(page), "cell name is not id");
  assert(/순번↑/.test(page) && /swapWithId/.test(page), "order uses existing swap");
  assert(
    /소속\/조 변경/.test(page) &&
      /기존 ID\/계정은 유지/.test(page) &&
      /caddyType: isThirdBandTeam\(draft\.team\) \? 'THIRD' : 'HOUSE'/.test(page),
    "affiliation move reuses PATCH, keeps id"
  );
  assert(
    !/onDragStart|draggable|일괄 저장|batchSave/.test(page),
    "no fake drag or batch save UI"
  );
  assert(
    /조장·기숙사\s*카트·1·3부 신청 색은 명단 고정값이 없어/.test(page),
    "explains missing field colors"
  );
  assert(
    /min-width:\s*168px/.test(page) &&
      /overflow-x:\s*auto/.test(page) &&
      /position:\s*sticky/.test(page) &&
      /min-height:\s*44px/.test(page),
    "PC sheet keeps column width, scroll, sticky, 44px rows"
  );
  assert(
    /@media \(min-width: 960px\)/.test(page) &&
      /cm-roster-mobile \{ display: none; \}/.test(page),
    "12 columns are not forced onto mobile"
  );
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
