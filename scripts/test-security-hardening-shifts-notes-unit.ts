/**
 * Security hardening: shifts GET auth, notes DELETE scope,
 * extra-tag createdBy, shifts write transaction.
 * 실행: npm run test:security-hardening-shifts-notes-unit
 */
import fs from "node:fs";
import path from "node:path";
import { caddyNoteDeleteWhere } from "../src/lib/caddyNoteAudit";
import { scheduleExtraTagCreatedBy } from "../src/lib/scheduleExtraTagWrite";
import {
  SHIFT_DUTY_REPLACE_EMPTY_MESSAGE,
  isShiftDutyReplaceEmptyError,
  replaceShiftDuties,
} from "../src/lib/shiftDutyReplace";

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

section("GET /api/shifts consumer + guard");
{
  const shifts = read("src/app/api/shifts/route.ts");
  const page = read("src/app/manage/shifts/page.tsx");
  const get = shifts.split("export async function POST")[0] || "";
  assert(
    page.includes("fetch(`/api/shifts?date=${date}&part=${part}`"),
    "only manage/shifts page loads GET /api/shifts"
  );
  assert(
    /requireAdmin/.test(get) && !/requirePublishedReader/.test(get),
    "GET /api/shifts uses requireAdmin, not published-reader"
  );
  assert(
    get.indexOf("requireAdmin") < get.indexOf("shiftDuty.findMany"),
    "GET requireAdmin runs before findMany"
  );
}

section("notes DELETE scope");
{
  const notes = read("src/app/api/caddies/[id]/notes.ts/route.ts");
  const where = caddyNoteDeleteWhere(12, 99);
  assert(where.id === 99, "delete where uses noteId");
  assert(where.entityId === 12, "delete where uses route caddyId");
  assert(where.entity === "Caddy", "delete where entity=Caddy");
  assert(where.action === "CADDY_NOTE", "delete where action=CADDY_NOTE");
  assert(
    /caddyNoteDeleteWhere\(caddyId,\s*noteId\)/.test(notes),
    "DELETE calls scoped where helper"
  );
  assert(/deleteMany/.test(notes), "DELETE uses deleteMany so 0-match is not a crash");
  assert(
    !/audit\.delete\(\s*\{\s*where:\s*\{\s*id:\s*noteId/.test(notes),
    "DELETE does not delete by noteId alone"
  );
}

section("extra-tag createdBy from actor");
{
  const extra = read("src/app/api/schedule/extra-tag/route.ts");
  assert(
    scheduleExtraTagCreatedBy({ username: "박성민" }) === "박성민",
    "createdBy is auth username"
  );
  assert(
    scheduleExtraTagCreatedBy({ username: "  admin  " }) === "admin",
    "createdBy trims username"
  );
  assert(
    scheduleExtraTagCreatedBy({ username: "" }) === null,
    "blank username → null"
  );
  assert(scheduleExtraTagCreatedBy(null) === null, "missing auth → null");
  assert(
    /scheduleExtraTagCreatedBy\(auth\)/.test(extra) &&
      /resolveAuthUser/.test(extra),
    "POST extra-tag sets createdBy from resolveAuthUser"
  );
  assert(
    !/createdBy:\s*createdBy\s*\?\?/.test(extra),
    "POST extra-tag does not trust body createdBy"
  );
}

section("POST /api/shifts transaction");
{
  const shifts = read("src/app/api/shifts/route.ts");
  const post = shifts.split("export async function POST")[1] || "";
  assert(/\$transaction/.test(post), "POST wraps writes in \$transaction");
  assert(
    post.indexOf("deleteMany") < post.indexOf("createMany"),
    "deleteMany still precedes createMany"
  );
  assert(
    /ShiftDutyReplaceEmptyError/.test(post),
    "empty replace rolls back via typed error"
  );
}

async function testReplaceHelper() {
  section("replaceShiftDuties helper");
  const ops: string[] = [];
  const date = new Date("2026-10-12T00:00:00.000Z");
  const tx = {
    shiftDuty: {
      async deleteMany() {
        ops.push("delete");
        return { count: 2 };
      },
      async createMany(args: { data: unknown[] }) {
        ops.push(`create:${args.data.length}`);
        return { count: args.data.length };
      },
    },
  };
  const n = await replaceShiftDuties(tx, {
    date,
    part: "ONE",
    rows: [
      {
        date,
        part: "ONE",
        variant: "NORMAL",
        orderNo: 1,
        caddyId: 7,
        team: "5조",
      },
    ],
  });
  assert(n === 1, "replace returns created count");
  assert(
    ops.join(",") === "delete,create:1",
    "replace deletes then creates in one helper"
  );

  const emptyOps: string[] = [];
  const emptyTx = {
    shiftDuty: {
      async deleteMany() {
        emptyOps.push("delete");
        return { count: 1 };
      },
      async createMany() {
        emptyOps.push("create");
        return { count: 0 };
      },
    },
  };
  let emptyErr: unknown;
  try {
    await replaceShiftDuties(emptyTx, { date, part: "ONE", rows: [] });
  } catch (e) {
    emptyErr = e;
  }
  assert(
    isShiftDutyReplaceEmptyError(emptyErr) &&
      emptyErr.message === SHIFT_DUTY_REPLACE_EMPTY_MESSAGE,
    "empty rows throw 400 message"
  );
  assert(
    emptyOps.join(",") === "delete",
    "empty replace does not createMany"
  );
}

testReplaceHelper()
  .then(() => {
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
