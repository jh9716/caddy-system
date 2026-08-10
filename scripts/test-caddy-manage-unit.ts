/**
 * DB 없는 캐디 관리 유틸/스키마 단위 테스트
 * 실행: npx tsx scripts/test-caddy-manage-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  employmentStatusLabel,
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
  parseEmploymentFilter,
} from "../src/lib/caddyManage";
import { caddyCreateSchema, caddyUpdateSchema } from "../src/lib/caddySchema";

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

console.log("== caddyManage ==");
assert(normalizeEmploymentStatus("재직") === "ACTIVE", "재직→ACTIVE");
assert(normalizeEmploymentStatus("휴직") === "LEAVE", "휴직→LEAVE");
assert(normalizeEmploymentStatus("퇴사") === "RETIRED", "퇴사→RETIRED");
assert(normalizeEmploymentStatus("ACTIVE") === "ACTIVE", "ACTIVE");
assert(normalizeEmploymentStatus("LEAVE") === "LEAVE", "LEAVE");
assert(normalizeEmploymentStatus("RETIRED") === "RETIRED", "RETIRED");
assert(normalizeEmploymentStatus("retired") === "RETIRED", "retired→RETIRED");
assert(employmentStatusLabel("ACTIVE") === "재직", "label ACTIVE");
assert(employmentStatusLabel("LEAVE") === "휴직", "label LEAVE");
assert(employmentStatusLabel("RETIRED") === "퇴사", "label RETIRED");
assert(parseEmploymentFilter("재직") === "ACTIVE", "filter 재직");
assert(parseEmploymentFilter("all") === "all", "filter all");
assert(parseEmploymentFilter("RETIRED") === "RETIRED", "filter RETIRED");
assert(normalizeTeamOrder(-3) === 0, "teamOrder floor at 0");
assert(normalizeTeamOrder(2.9) === 2, "teamOrder int");
assert(
  JSON.stringify(normalizeExtraFlags(["주중반", "dummy", "드라이빙", "주중반"])) ===
    JSON.stringify(["주중반", "드라이빙"]),
  "extraFlags normalize"
);

console.log("== caddySchema ==");
const created = caddyCreateSchema.safeParse({
  name: "홍길동",
  team: "3조",
  extraFlags: ["주말반"],
});
assert(created.success, "create schema ok");
assert(
  created.success && created.data.employmentStatus === "ACTIVE",
  "default ACTIVE"
);

const createdKo = caddyCreateSchema.safeParse({
  name: "홍길동",
  team: "3조",
  employmentStatus: "퇴사",
});
assert(
  createdKo.success && createdKo.data.employmentStatus === "RETIRED",
  "create accepts 한글 퇴사→RETIRED"
);

const bad = caddyCreateSchema.safeParse({ name: "", team: "1조" });
assert(!bad.success, "reject empty name");

const updated = caddyUpdateSchema.safeParse({
  teamOrder: 5,
  employmentStatus: "LEAVE",
  extraFlags: ["드라이빙"],
});
assert(updated.success, "update schema ok");
assert(
  updated.success && updated.data.employmentStatus === "LEAVE",
  "update LEAVE"
);

assert(
  created.success && created.data.employeeCode === undefined,
  "create omits employeeCode by default"
);
assert(
  created.success && created.data.caddyType === undefined,
  "create omits caddyType by default"
);
assert(
  created.success && created.data.missingFromImport === undefined,
  "create omits missingFromImport by default"
);

console.log("== soft-delete API source guard ==");
const apiFiles = [
  "src/app/api/caddies/route.ts",
  "src/app/api/caddies/[id]/route.ts",
];
for (const rel of apiFiles) {
  const src = fs.readFileSync(path.resolve(rel), "utf8");
  assert(
    !/prisma\.caddy\.delete(Many)?\s*\(/.test(src),
    `${rel} has no caddy hard-delete`
  );
  assert(
    src.includes('employmentStatus: "RETIRED"'),
    `${rel} soft-retires with RETIRED`
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
