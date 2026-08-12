/**
 * Caddy 휴대폰 정규화/마스킹 + 스키마 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-caddy-phone-unit.ts
 */
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
  normalizeKrMobile,
  parseOptionalPhoneInput,
} from "../src/lib/caddyPhone";
import { caddyCreateSchema, caddyUpdateSchema } from "../src/lib/caddySchema";
import fs from "node:fs";
import path from "node:path";

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

section("normalizeKrMobile formats");
{
  assert(normalizeKrMobile("010-1234-5678") === "01012345678", "dashed");
  assert(normalizeKrMobile("01012345678") === "01012345678", "digits");
  assert(normalizeKrMobile("+82 10 1234 5678") === "01012345678", "+82 spaced");
  assert(normalizeKrMobile("+82-10-1234-5678") === "01012345678", "+82 dashed");
  assert(normalizeKrMobile("82 10 1234 5678") === "01012345678", "82 prefix");
  assert(normalizeKrMobile("10 1234 5678") === "01012345678", "10 without 0");
  assert(normalizeKrMobile(" 010 1234 5678 ") === "01012345678", "trim spaces");
}

section("invalid rejected");
{
  const bad = [
    "02-123-4567",
    "011-123-4567",
    "010-123-456",
    "010123456789",
    "abc",
    "1234",
  ];
  for (const v of bad) {
    let threw = false;
    try {
      normalizeKrMobile(v);
    } catch (e) {
      threw = e instanceof CaddyPhoneError;
    }
    assert(threw, `reject ${v}`);
  }
}

section("null / empty allowed via parseOptional");
{
  assert(parseOptionalPhoneInput(null) === null, "null");
  assert(parseOptionalPhoneInput(undefined) === null, "undefined");
  assert(parseOptionalPhoneInput("") === null, "empty");
  assert(parseOptionalPhoneInput("   ") === null, "blank");
  assert(
    parseOptionalPhoneInput("010-9999-8888") === "01099998888",
    "valid optional"
  );
}

section("maskKrMobile");
{
  assert(maskKrMobile("01012345678") === "010-****-5678", "mask");
  assert(maskKrMobile(null) === null, "null mask");
  assert(maskKrMobile("") === null, "empty mask");
}

section("isPhoneUniqueViolation");
{
  assert(
    isPhoneUniqueViolation({
      code: "P2002",
      meta: { target: ["phoneNormalized"] },
    }),
    "target array"
  );
  assert(
    !isPhoneUniqueViolation({
      code: "P2002",
      meta: { target: ["employeeCode"] },
    }),
    "other unique"
  );
  assert(!isPhoneUniqueViolation({ code: "P2003" }), "other code");
}

section("zod create/update accept phone");
{
  const c = caddyCreateSchema.safeParse({
    name: "테스트",
    team: "1조",
    phone: "010-1111-2222",
  });
  assert(c.success && c.data.phone === "010-1111-2222", "create phone raw");

  const cEmpty = caddyCreateSchema.safeParse({
    name: "테스트",
    team: "1조",
    phone: "",
  });
  assert(cEmpty.success && cEmpty.data.phone === "", "create empty phone");

  const u = caddyUpdateSchema.safeParse({ phone: null });
  assert(u.success && u.data.phone === null, "update clear phone");

  const uOmit = caddyUpdateSchema.safeParse({ teamOrder: 1 });
  assert(
    uOmit.success && !Object.prototype.hasOwnProperty.call(uOmit.data, "phone"),
    "update omit phone"
  );
}

section("schema migration add-only");
{
  const mig = fs.readFileSync(
    path.resolve(
      "prisma/migrations/20260812040000_caddy_phone_normalized/migration.sql"
    ),
    "utf8"
  );
  assert(mig.includes('ADD COLUMN IF NOT EXISTS "phoneNormalized"'), "add column");
  assert(mig.includes("UNIQUE"), "unique");
  assert(!/UPDATE\s+"Caddy"/i.test(mig), "no caddy row update");
  assert(!/DELETE\s+FROM/i.test(mig), "no delete");
  assert(
    !/UPDATE\s+"(User|OffRequest|Assignment)"/i.test(mig) &&
      !/DELETE\s+FROM\s+"(User|OffRequest|Assignment)"/i.test(mig),
    "no other table DML"
  );
}

section("admin API phone + schedule omit source guard");
{
  const list = fs.readFileSync(
    path.resolve("src/app/api/caddies/route.ts"),
    "utf8"
  );
  assert(list.includes("requireAdmin"), "list requireAdmin");
  assert(list.includes("phoneNormalized"), "create writes phoneNormalized");
  assert(list.includes("isPhoneUniqueViolation"), "create 409 path");

  const patch = fs.readFileSync(
    path.resolve("src/app/api/caddies/[id]/route.ts"),
    "utf8"
  );
  assert(patch.includes("requireAdmin"), "patch requireAdmin");
  assert(patch.includes("hasOwnProperty.call(body, \"phone\")"), "omit-safe phone");
  assert(patch.includes("maskKrMobile"), "audit masks phone");

  const schedule = fs.readFileSync(
    path.resolve("src/app/api/schedule/route.ts"),
    "utf8"
  );
  assert(
    schedule.includes("phoneNormalized 등 PII 제외") ||
      !schedule.includes("include: { caddy: true }"),
    "schedule does not include full caddy"
  );
  assert(!/phoneNormalized:\s*true/.test(schedule), "schedule select omits phone");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
