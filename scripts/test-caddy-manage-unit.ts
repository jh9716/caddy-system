/**
 * DB 없는 캐디 관리 유틸/스키마 단위 테스트
 * 실행: npx tsx scripts/test-caddy-manage-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  employmentStatusLabel,
  isThirdBandTeam,
  normalizeEmploymentStatus,
  normalizeExtraFlags,
  normalizeTeamOrder,
  parseEmploymentFilter,
  mergeExtraFlagsForPersist,
  parseThirdBandSubgroupInput,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
  ThirdBandSubgroupError,
  EDITABLE_EXTRA_FLAG_OPTIONS,
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
  teamOrder: 2,
  extraFlags: ["주말반"],
});
assert(created.success, "create schema ok");
assert(
  created.success && created.data.employmentStatus === "ACTIVE",
  "default ACTIVE"
);
assert(created.success && created.data.teamOrder === 2, "create teamOrder set");

const createdKo = caddyCreateSchema.safeParse({
  name: "홍길동",
  team: "3조",
  teamOrder: 1,
  employmentStatus: "퇴사",
});
assert(
  createdKo.success && createdKo.data.employmentStatus === "RETIRED",
  "create accepts 한글 퇴사→RETIRED"
);

const bad = caddyCreateSchema.safeParse({ name: "", team: "1조", teamOrder: 1 });
assert(!bad.success, "reject empty name");

const noSlot = caddyCreateSchema.safeParse({ name: "홍길동", team: "1조" });
assert(!noSlot.success, "reject missing teamOrder");

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

console.log("== caddyType from team ==");
assert(resolveCaddyTypeFromTeam("1조") === "HOUSE", "1조 → HOUSE");
assert(resolveCaddyTypeFromTeam("8조") === "HOUSE", "8조 → HOUSE");
assert(resolveCaddyTypeFromTeam("9조") === "THIRD", "9조 → THIRD");
assert(resolveCaddyTypeFromTeam("10조") === "THIRD", "10조 → THIRD");
assert(resolveCaddyTypeFromTeam("12조") === "THIRD", "12조 → THIRD");
assert(
  resolveCaddyTypeFromTeam("8조") === "HOUSE" &&
    resolveCaddyTypeFromTeam("9조") === "THIRD",
  "8→9 이동 시 THIRD"
);
assert(
  resolveCaddyTypeFromTeam("9조") === "THIRD" &&
    resolveCaddyTypeFromTeam("8조") === "HOUSE",
  "9→8 이동 시 HOUSE"
);

console.log("== thirdBandSubgroup ==");
assert(isThirdBandTeam("9조") && isThirdBandTeam("12조"), "9~12 are third band");
assert(!isThirdBandTeam("1조") && !isThirdBandTeam("8조"), "1~8 not third band");
assert(parseThirdBandSubgroupInput(undefined) === undefined, "parse omit");
assert(parseThirdBandSubgroupInput(null) === null, "parse null");
assert(parseThirdBandSubgroupInput("일반") === null, "parse 일반");
assert(parseThirdBandSubgroupInput("WEEKDAY") === "WEEKDAY", "parse WEEKDAY");
assert(parseThirdBandSubgroupInput("주말") === "WEEKEND", "parse 주말");

assert(
  resolveThirdBandSubgroup({ team: "9조", requested: "WEEKDAY" }) === "WEEKDAY",
  "9조 + WEEKDAY"
);
assert(
  resolveThirdBandSubgroup({ team: "10조", requested: "WEEKEND" }) === "WEEKEND",
  "10조 + WEEKEND"
);
assert(
  resolveThirdBandSubgroup({ team: "11조", requested: null }) === null,
  "11조 + null"
);
assert(
  resolveThirdBandSubgroup({ team: "12조", requested: undefined, current: null }) ===
    null,
  "12조 omit → null"
);

try {
  resolveThirdBandSubgroup({ team: "1조", requested: "WEEKDAY" });
  assert(false, "1조 + WEEKDAY must throw");
} catch (e) {
  assert(
    e instanceof ThirdBandSubgroupError,
    "1조 + WEEKDAY → ThirdBandSubgroupError"
  );
}
try {
  resolveThirdBandSubgroup({ team: "8조", requested: "WEEKEND" });
  assert(false, "8조 + WEEKEND must throw");
} catch (e) {
  assert(
    e instanceof ThirdBandSubgroupError,
    "8조 + WEEKEND → ThirdBandSubgroupError"
  );
}

assert(
  resolveThirdBandSubgroup({
    team: "3조",
    requested: undefined,
    current: "WEEKDAY",
  }) === null,
  "9~12→1~8: omit still clears to null"
);
assert(
  resolveThirdBandSubgroup({
    team: "9조",
    requested: undefined,
    current: null,
  }) === null,
  "1~8→9~12: no auto WEEKDAY/WEEKEND (null)"
);
assert(
  resolveThirdBandSubgroup({
    team: "9조",
    requested: undefined,
    current: "WEEKDAY",
  }) === "WEEKDAY",
  "9→9 omit keeps WEEKDAY"
);

const create9 = caddyCreateSchema.safeParse({
  name: "삼부",
  team: "9조",
  teamOrder: 1,
  thirdBandSubgroup: "WEEKDAY",
});
assert(
  create9.success && create9.data.thirdBandSubgroup === "WEEKDAY",
  "create schema accepts 9조 WEEKDAY"
);
const create10 = caddyCreateSchema.safeParse({
  name: "주말",
  team: "10조",
  teamOrder: 1,
  thirdBandSubgroup: "WEEKEND",
});
assert(
  create10.success && create10.data.thirdBandSubgroup === "WEEKEND",
  "create schema accepts 10조 WEEKEND"
);
const updateNull = caddyUpdateSchema.safeParse({
  team: "11조",
  thirdBandSubgroup: null,
});
assert(
  updateNull.success && updateNull.data.thirdBandSubgroup === null,
  "update schema accepts null"
);

console.log("== legacy extraFlags 보존 / 신규 이중입력 차단 ==");
{
  const preserved = mergeExtraFlagsForPersist({
    incoming: ["드라이빙"],
    current: ["주중반", "드라이빙"],
    mode: "update",
  });
  assert(
    JSON.stringify(preserved) === JSON.stringify(["주중반", "드라이빙"]),
    "edit save: 주중반+기타(드라이빙) 보존"
  );

  const weekendOnly = mergeExtraFlagsForPersist({
    incoming: [],
    current: ["주말반"],
    mode: "update",
  });
  assert(
    JSON.stringify(weekendOnly) === JSON.stringify(["주말반"]),
    "other fields only: 주말반 보존"
  );

  const weekdayPlusOther = mergeExtraFlagsForPersist({
    incoming: ["드라이빙"],
    current: ["주중반", "기타무시됨"],
    mode: "update",
  });
  assert(
    weekdayPlusOther.includes("주중반") && weekdayPlusOther.includes("드라이빙"),
    "주중반+기타값(편집가능) 보존"
  );

  const createWeekdayLeak = mergeExtraFlagsForPersist({
    incoming: ["주중반", "드라이빙"],
    mode: "create",
  });
  assert(
    JSON.stringify(createWeekdayLeak) === JSON.stringify(["드라이빙"]),
    "create: 주중반 신규 추가 차단, 드라이빙만"
  );

  const createWeekendLeak = mergeExtraFlagsForPersist({
    incoming: ["주말반"],
    mode: "create",
  });
  assert(
    JSON.stringify(createWeekendLeak) === JSON.stringify([]),
    "create: 주말반 신규 추가 차단"
  );

  // UI: 주중/주말 선택 → thirdBandSubgroup만 (extraFlags 자동 추가 없음)
  const uiCreateWeekdayFlags = mergeExtraFlagsForPersist({
    incoming: [],
    mode: "create",
  });
  assert(
    uiCreateWeekdayFlags.length === 0 &&
      resolveThirdBandSubgroup({ team: "9조", requested: "WEEKDAY" }) ===
        "WEEKDAY",
    "신규 주중 → WEEKDAY only, extraFlags에 주중반 없음"
  );
  assert(
    mergeExtraFlagsForPersist({ incoming: [], mode: "create" }).length === 0 &&
      resolveThirdBandSubgroup({ team: "10조", requested: "WEEKEND" }) ===
        "WEEKEND",
    "신규 주말 → WEEKEND only, extraFlags에 주말반 없음"
  );

  assert(
    resolveThirdBandSubgroup({
      team: "1조",
      requested: undefined,
      current: "WEEKDAY",
    }) === null,
    "9~12→1~8: thirdBandSubgroup null"
  );

  assert(
    JSON.stringify(EDITABLE_EXTRA_FLAG_OPTIONS) ===
      JSON.stringify(["드라이빙"]),
    "UI editable extraFlags = 드라이빙 only"
  );

  const uiSrc = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  assert(
    /EDITABLE_EXTRA_FLAG_OPTIONS\.map/.test(uiSrc) &&
      !/\bEXTRA_FLAG_OPTIONS\.map/.test(uiSrc) &&
      !/checked=\{[^}]*주중반/.test(uiSrc),
    "manage UI maps EDITABLE flags only (no 주중반/주말반 checkbox)"
  );
}

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
  assert(
    src.includes("resolveCaddyTypeFromTeam"),
    `${rel} forces caddyType from team`
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
