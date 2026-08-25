/**
 * 운영 UI 캐디 표시명 formatter + 화면 소스 가드
 * 실행: npx tsx scripts/test-caddy-display-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DRIVING_POOL_TEAM } from "../src/lib/caddyManage";
import { caddyAffiliation, formatCaddyLabel } from "../src/lib/caddyDisplay";

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

console.log("== formatCaddyLabel ==");
assert(formatCaddyLabel({ name: "신정훈", team: "7조" }) === "7조 신정훈", "7조 신정훈");
assert(
  formatCaddyLabel({ name: "박준현", team: DRIVING_POOL_TEAM }) === "드라이빙 박준현",
  "team 드라이빙"
);
assert(
  formatCaddyLabel({ name: "박준현", team: "9조", caddyType: "DRIVING" }) ===
    "드라이빙 박준현",
  "caddyType DRIVING이 조보다 우선"
);
assert(formatCaddyLabel({ name: "  김청운  ", team: "1조" }) === "1조 김청운", "이름 trim");
assert(formatCaddyLabel({ name: "", team: "2조" }) === "2조 이름없음", "빈 이름");
assert(formatCaddyLabel({ name: "홍길동", team: "" }) === "홍길동", "조 없음");
assert(
  formatCaddyLabel({ name: "신정훈", team: "7조" }, { disambiguator: "3번" }) ===
    "7조 신정훈 3번",
  "optional disambiguator"
);
assert(
  formatCaddyLabel({ name: "신정훈", team: "7조" }, { disambiguator: "" }) ===
    "7조 신정훈",
  "빈 disambiguator는 붙이지 않음"
);
assert(
  !formatCaddyLabel({ name: "신정훈", team: "7조", caddyType: "HOUSE" }).includes("id"),
  "label에 id 없음"
);

console.log("== caddyAffiliation ==");
assert(caddyAffiliation({ team: "7조" }) === "7조", "일반 조");
assert(caddyAffiliation({ team: "9조", caddyType: "DRIVING" }) === "드라이빙", "DRIVING type");
assert(caddyAffiliation({ team: "드라이빙" }) === "드라이빙", "드라이빙 팀명");

console.log("== UI source: id/teamOrder not shown as identity ==");
const uiFiles = [
  "src/app/manage/assignments/page.tsx",
  "src/app/manage/assignments/LiveChangePanel.tsx",
  "src/app/manage/assignments/SpecialDutyPanel.tsx",
  "src/app/manage/assignments/preview/page.tsx",
  "src/app/manage/caddies/page.tsx",
  "src/app/manage/users/page.tsx",
  "src/app/manage/availability/page.tsx",
];
for (const rel of uiFiles) {
  const src = fs.readFileSync(path.resolve(rel), "utf8");
  assert(src.includes("formatCaddyLabel"), `${rel} uses formatCaddyLabel`);
  assert(!src.includes("#{c.id}"), `${rel} no #{c.id}`);
  assert(!src.includes("#{caddy.id}"), `${rel} no #{caddy.id}`);
  assert(!/\(id \{c\.id\}/.test(src), `${rel} no (id {c.id})`);
  assert(!/id=\{c\.id\}/.test(src), `${rel} no id={c.id} in label text`);
  assert(!/· 순번 \{c\.teamOrder\}/.test(src), `${rel} no · 순번 {c.teamOrder}`);
  assert(!/teamOrder\}번 \(id/.test(src), `${rel} no teamOrder번 (id`);
  assert(
    !/\(id \$\{c\.id\}/.test(src) && !/\(id=\$\{/.test(src),
    `${rel} no (id=\${...}) toast`
  );
}

{
  const preview = fs.readFileSync(
    path.resolve("src/app/manage/assignments/preview/page.tsx"),
    "utf8"
  );
  assert(!preview.includes('headers={["ID"'), "preview unused table no ID header");
  assert(!preview.includes('"teamOrder"'), "preview no teamOrder header");
  assert(!preview.includes("순번idx"), "preview no 순번idx");
  assert(!preview.includes("(#${a.caddy.id})"), "preview no (#id) in caddy cell");
}

{
  const board = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  assert(
    !board.includes("{row.caddy.team}·{row.caddy.teamOrder}"),
    "board list no team·teamOrder meta"
  );
  assert(
    !board.includes("teamOrder}번 (id {c.id})"),
    "1부 첫 캐디 selector no id"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
