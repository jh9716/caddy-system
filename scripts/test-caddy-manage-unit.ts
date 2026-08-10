/**
 * DB 없는 캐디 관리 유틸/스키마 단위 테스트
 * 실행: npx tsx scripts/test-caddy-manage-unit.ts
 */
import {
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
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
assert(normalizeEmploymentStatus("재직") === "재직", "재직");
assert(normalizeEmploymentStatus("퇴사") === "퇴사", "퇴사");
assert(normalizeEmploymentStatus("RETIRED") === "퇴사", "RETIRED→퇴사");
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
assert(created.success && created.data.employmentStatus === "재직", "default 재직");

const bad = caddyCreateSchema.safeParse({ name: "", team: "1조" });
assert(!bad.success, "reject empty name");

const updated = caddyUpdateSchema.safeParse({
  teamOrder: 5,
  employmentStatus: "퇴사",
  extraFlags: ["드라이빙"],
});
assert(updated.success, "update schema ok");

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
