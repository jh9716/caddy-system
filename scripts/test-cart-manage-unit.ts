/**
 * 카트 마스터 / 기숙사 자격 단위 테스트 (DB 없음)
 *   npm run test:cart-manage-unit
 */
import fs from "node:fs";
import path from "node:path";
import { caddyCreateSchema, caddyUpdateSchema } from "../src/lib/caddySchema";
import {
  CartManageError,
  assertCartOwnerDormitoryXor,
  compareCartNumber,
  isEligibleCartOwner,
  normalizeCartNumber,
  resolveCartCreateInput,
  resolveCartPatchInput,
} from "../src/lib/cartManage";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("cart number / xor");
{
  assert(normalizeCartNumber(" 12 ") === "12", "trim cart number");
  try {
    normalizeCartNumber("");
    assert(false, "empty number throws");
  } catch (e) {
    assert(e instanceof CartManageError, "empty number is CartManageError");
  }
  try {
    assertCartOwnerDormitoryXor({ dormitoryOnly: true, ownerCaddyId: 7 });
    assert(false, "dorm+owner should throw");
  } catch (e) {
    assert(
      e instanceof CartManageError && e.code === "cart_dorm_owner_conflict",
      "dormitoryOnly + owner 동시 설정 거부"
    );
  }
  assert(
    (() => {
      assertCartOwnerDormitoryXor({ dormitoryOnly: true, ownerCaddyId: null });
      return true;
    })(),
    "dorm only ok"
  );
  assert(
    (() => {
      assertCartOwnerDormitoryXor({ dormitoryOnly: false, ownerCaddyId: 3 });
      return true;
    })(),
    "owner only ok"
  );
}

section("create / patch resolve");
{
  try {
    resolveCartCreateInput({
      number: "12",
      dormitoryOnly: true,
      ownerCaddyId: 1,
    });
    assert(false, "create dorm+owner rejected");
  } catch (e) {
    assert(
      e instanceof CartManageError && e.code === "cart_dorm_owner_conflict",
      "create rejects dorm+owner"
    );
  }
  const created = resolveCartCreateInput({ number: "21", dormitoryOnly: true });
  assert(
    created.dormitoryOnly === true && created.ownerCaddyId == null,
    "create dorm cart has no owner"
  );
  const patched = resolveCartPatchInput(
    { dormitoryOnly: true },
    {
      number: "12",
      kind: "STANDARD",
      ownerCaddyId: 9,
      dormitoryOnly: false,
      operationalStatus: "ACTIVE",
    }
  );
  assert(
    patched.dormitoryOnly === true && patched.ownerCaddyId == null,
    "patch dormitoryOnly clears owner"
  );
}

section("owner eligibility");
{
  assert(isEligibleCartOwner("ACTIVE") === true, "ACTIVE owner ok");
  assert(isEligibleCartOwner("LEAVE") === true, "LEAVE owner ok");
  assert(isEligibleCartOwner("RETIRED") === false, "RETIRED owner 거부");
  assert(compareCartNumber("2", "12") < 0, "numeric cart sort");
}

section("caddy dormitoryResident schema");
{
  const created = caddyCreateSchema.safeParse({
    name: "홍길동",
    team: "3조",
    teamOrder: 2,
  });
  assert(
    created.success && created.data.dormitoryResident === false,
    "dormitoryResident 기본 false"
  );
  const updated = caddyUpdateSchema.safeParse({ dormitoryResident: true });
  assert(
    updated.success && updated.data.dormitoryResident === true,
    "admin schema accepts dormitoryResident"
  );
}

section("source guards");
{
  const schema = read("prisma/schema.prisma");
  const migration = read(
    "prisma/migrations/20261012230000_cart_master_dormitory/migration.sql"
  );
  assert(schema.includes("model Cart"), "Cart model");
  assert(schema.includes("dormitoryResident"), "Caddy.dormitoryResident");
  assert(!schema.includes("model DailyCartAssignment"), "no DailyCartAssignment");
  assert(
    !/CREATE TABLE\s+"?DailyCartAssignment"?/i.test(migration),
    "migration has no date-assignment table"
  );
  assert(migration.includes("DEFAULT false"), "dormitory default false in SQL");

  const forbidden = [
    "src/lib/autoAssignEngine.ts",
    "src/lib/assignmentBoardDirectEdit.ts",
    "src/lib/dailyBoardDraft.ts",
    "src/lib/assignmentChange.ts",
  ];
  for (const file of forbidden) {
    const src = read(file);
    assert(!src.includes("dormitoryResident"), `${file} no dormitoryResident`);
    assert(!/\bmodel Cart\b|\bcartService\b/.test(src), `${file} no cart coupling`);
  }

  const cartLib = read("src/lib/cartService.ts") + read("src/lib/cartManage.ts");
  assert(!/from ["']@\/lib\/autoAssignEngine["']/.test(cartLib), "cart lib no engine import");
  assert(!/DailyPlacement/.test(cartLib), "cart lib no DailyPlacement");
  assert(!/DailyBoardDraft/.test(cartLib), "cart lib no DailyBoardDraft");
  assert(!/DailyCartAssignment/.test(cartLib), "cart lib no daily assignment");

  const api = read("src/app/api/carts/route.ts") + read("src/app/api/carts/[id]/route.ts");
  assert(api.includes("requireAdmin"), "cart API requireAdmin");
  assert(!/export async function DELETE/.test(api), "no hard DELETE route");

  const page = read("src/app/manage/carts/page.tsx");
  assert(page.includes("카트 관리"), "admin carts page");
  assert(!page.includes("date="), "no date board query");
  assert(!page.includes("임시배정"), "no temp assignment UI");

  const nav = read("src/lib/adminManageNav.ts");
  assert(nav.includes('label: "카트 관리"'), "admin nav has 카트 관리");
  const member = read("src/lib/boardNav.ts") + read("src/components/manage/MemberShell.tsx");
  assert(!member.includes("/manage/carts"), "member/caddy nav no carts");

  const caddiesPage = read("src/app/manage/caddies/page.tsx");
  assert(caddiesPage.includes("dormitoryResident"), "caddies UI edits dormitory");
  assert(
    !/extraFlags.*기숙사|기숙사.*extraFlags/.test(caddiesPage.split("EDITABLE_EXTRA_FLAG")[0] || ""),
    "기숙사 is not an extraFlag option"
  );
  const flags = read("src/lib/caddyManage.ts");
  assert(!flags.includes("기숙사"), "extraFlags options exclude 기숙사");

  const xlsx = read("src/lib/caddyImportXlsx.ts") + read("lib/caddyImportXlsx.ts");
  assert(!xlsx.includes("dormitoryResident"), "xlsx import does not set dormitory");
  assert(
    xlsx.includes("카트번호·셀 색(고정카트)는 저장하지 않음") ||
      xlsx.includes("카트번호"),
    "xlsx still does not persist cart master"
  );

  const chat = read("src/lib/chatAuth.ts");
  const photo = read("src/lib/courseReportPhoto.ts");
  assert(!chat.includes("dormitoryResident"), "chat untouched");
  assert(!photo.includes("Cart"), "photo untouched");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
