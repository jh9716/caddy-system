/**
 * 캐디 차량번호 필드 / 관리자 전용 표시 단위 테스트 (DB 없음)
 * 실행: npm run test:caddy-vehicle-unit
 */
import fs from "node:fs";
import path from "node:path";
import { caddyCreateSchema, caddyUpdateSchema } from "../src/lib/caddySchema";
import {
  CaddyVehicleError,
  VEHICLE_NUMBER_MAX_LEN,
  auditVehicleNumber,
  formatVehicleDisplay,
  parseOptionalVehicleInput,
} from "../src/lib/caddyVehicle";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

section("parseOptionalVehicleInput");
{
  assert(parseOptionalVehicleInput(null) === null, "null");
  assert(parseOptionalVehicleInput(undefined) === null, "undefined");
  assert(parseOptionalVehicleInput("") === null, "empty");
  assert(parseOptionalVehicleInput("   ") === null, "blank");
  assert(parseOptionalVehicleInput("12가3456") === "12가3456", "compact plate");
  assert(parseOptionalVehicleInput(" 12가 3456 ") === "12가 3456", "collapse spaces");
  assert(parseOptionalVehicleInput("서울12가3456") === "서울12가3456", "region prefix");

  let longThrew = false;
  try {
    parseOptionalVehicleInput("가".repeat(VEHICLE_NUMBER_MAX_LEN + 1));
  } catch (e) {
    longThrew = e instanceof CaddyVehicleError;
  }
  assert(longThrew, "reject too long");

  let badThrew = false;
  try {
    parseOptionalVehicleInput("<script>");
  } catch (e) {
    badThrew = e instanceof CaddyVehicleError;
  }
  assert(badThrew, "reject special chars");
}

section("display / audit (no raw plate in audit)");
{
  assert(formatVehicleDisplay("12가3456") === "12가3456", "display");
  assert(formatVehicleDisplay("  ") === null, "blank display");
  assert(formatVehicleDisplay(null) === null, "null display");
  assert(auditVehicleNumber("12가3456") === "set", "audit set");
  assert(auditVehicleNumber("") === null, "audit empty");
  assert(auditVehicleNumber("12가3456") !== "12가3456", "audit omits plate");
}

section("zod create/update accept vehicleNumber");
{
  const c = caddyCreateSchema.safeParse({
    name: "테스트",
    team: "1조",
    teamOrder: 1,
    vehicleNumber: "12가3456",
  });
  assert(c.success && c.data.vehicleNumber === "12가3456", "create vehicle");

  const cEmpty = caddyCreateSchema.safeParse({
    name: "테스트",
    team: "1조",
    teamOrder: 1,
    vehicleNumber: "",
  });
  assert(cEmpty.success && cEmpty.data.vehicleNumber === "", "create empty vehicle");

  const u = caddyUpdateSchema.safeParse({ vehicleNumber: null });
  assert(u.success && u.data.vehicleNumber === null, "update clear vehicle");

  const uOmit = caddyUpdateSchema.safeParse({ teamOrder: 1 });
  assert(
    uOmit.success &&
      !Object.prototype.hasOwnProperty.call(uOmit.data, "vehicleNumber"),
    "update omit vehicle"
  );
}

section("schema migration add-only");
{
  const schema = read("prisma/schema.prisma");
  const mig = read(
    "prisma/migrations/20261108120000_caddy_vehicle_number/migration.sql"
  );
  assert(/vehicleNumber\s+String\?/.test(schema), "prisma optional field");
  assert(mig.includes('ADD COLUMN IF NOT EXISTS "vehicleNumber"'), "add column");
  assert(!/UPDATE\s+"Caddy"/i.test(mig), "no caddy row update");
  assert(!/DELETE\s+FROM/i.test(mig), "no delete");
  assert(!/DROP COLUMN/i.test(mig), "no drop");
  assert(
    !/UPDATE\s+"(User|OffRequest|Assignment)"/i.test(mig) &&
      !/DELETE\s+FROM\s+"(User|OffRequest|Assignment)"/i.test(mig),
    "no other table DML"
  );
}

section("admin API / UI source guards");
{
  const list = read("src/app/api/caddies/route.ts");
  const patch = read("src/app/api/caddies/[id]/route.ts");
  const searchApi = read("src/app/api/caddies/search/route.ts");
  const searchPage = read("src/app/manage/caddy-search/page.tsx");
  const caddiesPage = read("src/app/manage/caddies/page.tsx");
  const vehicleLib = read("src/lib/caddyVehicle.ts");
  const schedule = read("src/app/api/schedule/route.ts");
  const published = read("src/lib/dailyBoardPublished.ts");
  const boardPage = read("src/app/board/page.tsx");
  const snapshot = read("src/lib/dailyOpsSnapshot.ts");
  const memberNav = read("src/lib/boardNav.ts");
  const caddyDash = read("src/app/caddy/link/CaddyLinkClient.tsx");

  assert(/requireAdmin/.test(list), "list requireAdmin");
  assert(/parseOptionalVehicleInput/.test(list), "create writes vehicleNumber");
  assert(/requireAdmin/.test(patch), "patch requireAdmin");
  assert(
    patch.includes('hasOwnProperty.call(body, "vehicleNumber")'),
    "omit-safe vehicle"
  );
  assert(/auditVehicleNumber/.test(patch), "audit masks vehicle plate");
  assert(/requireAdmin/.test(searchApi), "search GET requireAdmin");
  assert(/vehicleNumber: true/.test(searchApi), "search select vehicle");
  assert(/hit\.vehicleNumber/.test(searchPage), "search UI shows vehicle");
  assert(/hit\.displayPhone/.test(searchPage), "search UI shows full phone");
  assert(/차량번호/.test(caddiesPage), "manage UI vehicle field");
  assert(/formatKrMobileDisplay/.test(caddiesPage), "manage UI unmasks phone");
  assert(!/maskKrMobile/.test(caddiesPage), "manage UI no longer masks phone");
  assert(
    !/console\.(log|info|debug|warn)\([^)]*vehicle/i.test(vehicleLib),
    "vehicle lib no console"
  );
  assert(
    !/console\.(log|info|debug|warn)\([^)]*vehicle/i.test(list),
    "list API no vehicle console"
  );
  assert(
    !/console\.(log|info|debug|warn)\([^)]*vehicle/i.test(patch),
    "patch API no vehicle console"
  );
  assert(!/vehicleNumber:\s*true/.test(schedule), "schedule omits vehicle");
  assert(!/vehicleNumber/.test(published), "published payload no vehicle");
  assert(!/vehicleNumber/.test(boardPage), "/board no vehicle");
  assert(
    /SNAPSHOT_FORBIDDEN_KEYS/.test(snapshot) && /vehicleNumber/.test(snapshot),
    "ops snapshot vehicle 금지 유지"
  );
  assert(!/href: "\/schedule"/.test(memberNav), "member nav no /schedule");
  assert(!/vehicleNumber/.test(caddyDash), "member link UI no vehicle field");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
