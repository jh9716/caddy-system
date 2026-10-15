/**
 * 캐디 명단 V2 XLSX apply 단위 테스트 (in-memory transaction mock)
 * Production DB write 없음.
 * npx tsx scripts/test-caddy-roster-import-xlsx-v2-apply-unit.ts
 */

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildRosterExportCsv } from "../lib/caddyRosterImportV2";
import {
  buildRosterExportXlsxBuffer,
  readRosterExportXlsxSheets,
  type RosterExportXlsxRow,
} from "../lib/caddyRosterExportXlsx";
import {
  applyXlsxV2Workbook,
  XlsxV2ApplyError,
  type XlsxV2ApplyDb,
} from "../lib/caddyRosterImportXlsxV2Apply";
import {
  buildXlsxV2WorkbookPreview,
  fingerprintRosterSnapshot,
} from "../lib/caddyRosterImportXlsxV2Preview";
import { DRIVING_POOL_TEAM, drivingPersistFields } from "../src/lib/caddyManage";
import { employmentBecameRetired } from "../src/lib/sessionRevocation";

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

function section(title: string) {
  console.log(`\n== ${title} ==`);
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

type CaddyRow = RosterExportXlsxRow;
type UserRow = { id: number; caddyId: number; sessionVersion: number };
type AuditRow = { id: number; data: Record<string, unknown> };

function cloneCaddies(rows: CaddyRow[]): CaddyRow[] {
  return JSON.parse(JSON.stringify(rows));
}

function rebuild(
  base: Buffer,
  mutate: (sheets: Record<string, Array<Array<string | number>>>) => void
): Buffer {
  const { sheetNames, sheets } = readRosterExportXlsxSheets(base);
  mutate(sheets);
  const wb = XLSX.utils.book_new();
  for (const name of sheetNames) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(sheets[name] ?? []),
      name
    );
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function existingRow(
  sheets: Record<string, Array<Array<string | number>>>,
  id: number
) {
  return sheets["기존캐디"].find((r, i) => i > 0 && Number(r[0]) === id);
}

function createApplyDb(input: {
  caddies: CaddyRow[];
  users?: UserRow[];
  throwOn?: "firstUpdate" | "create" | "retire" | "audit";
}): XlsxV2ApplyDb & {
  caddies: Map<number, CaddyRow>;
  users: Map<number, UserRow>;
  audits: AuditRow[];
  writeAttempts: { update: number; create: number; retire: number; audit: number };
  deletedCaddies: number;
  deletedUsers: number;
} {
  const caddies = new Map(input.caddies.map((row) => [row.id, { ...row }]));
  const users = new Map((input.users ?? []).map((row) => [row.id, { ...row }]));
  const audits: AuditRow[] = [];
  let nextCaddyId = Math.max(0, ...input.caddies.map((r) => r.id)) + 1;
  let nextAuditId = 1;
  const writeAttempts = { update: 0, create: 0, retire: 0, audit: 0 };
  const deletedCaddies = 0;
  const deletedUsers = 0;

  function snapshot() {
    return {
      caddies: new Map([...caddies.entries()].map(([k, v]) => [k, { ...v }])),
      users: new Map([...users.entries()].map(([k, v]) => [k, { ...v }])),
      audits: audits.map((a) => ({ ...a, data: { ...a.data } })),
      nextCaddyId,
      nextAuditId,
    };
  }

  function restore(snap: ReturnType<typeof snapshot>) {
    caddies.clear();
    for (const [k, v] of snap.caddies) caddies.set(k, { ...v });
    users.clear();
    for (const [k, v] of snap.users) users.set(k, { ...v });
    audits.splice(0, audits.length, ...snap.audits.map((a) => ({ ...a })));
    nextCaddyId = snap.nextCaddyId;
    nextAuditId = snap.nextAuditId;
  }

  const tx = {
    caddy: {
      findMany: async () =>
        [...caddies.values()].sort(
          (a, b) =>
            a.team.localeCompare(b.team) || a.teamOrder - b.teamOrder || a.id - b.id
        ),
      update: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const row = caddies.get(where.id);
        if (!row) throw new Error(`caddy ${where.id} not found`);
        const retiring = data.employmentStatus === "RETIRED";
        if (retiring) writeAttempts.retire += 1;
        else writeAttempts.update += 1;
        if (input.throwOn === "firstUpdate" && writeAttempts.update === 1) {
          throw new Error("forced mid-transaction failure");
        }
        if (input.throwOn === "retire" && retiring) {
          throw new Error("forced retire failure");
        }
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writeAttempts.create += 1;
        if (input.throwOn === "create") {
          throw new Error("forced create failure");
        }
        const row: CaddyRow = {
          id: nextCaddyId++,
          name: String(data.name),
          team: String(data.team),
          teamOrder: Number(data.teamOrder) || 0,
          employmentStatus: String(data.employmentStatus),
          phoneNormalized: (data.phoneNormalized as string | null) ?? null,
          thirdBandSubgroup:
            (data.thirdBandSubgroup as CaddyRow["thirdBandSubgroup"]) ?? null,
          caddyType: (data.caddyType as CaddyRow["caddyType"]) ?? null,
        };
        caddies.set(row.id, row);
        return { id: row.id };
      },
    },
    user: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { caddyId: number };
        data: { sessionVersion: { increment: number } };
      }) => {
        let count = 0;
        for (const user of users.values()) {
          if (user.caddyId === where.caddyId) {
            user.sessionVersion += data.sessionVersion.increment;
            count += 1;
          }
        }
        return { count };
      },
    },
    audit: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writeAttempts.audit += 1;
        if (input.throwOn === "audit") {
          throw new Error("forced audit failure");
        }
        const row = { id: nextAuditId++, data };
        audits.push(row);
        return { id: row.id };
      },
    },
  };

  return {
    caddies,
    users,
    audits,
    writeAttempts,
    deletedCaddies,
    deletedUsers,
    $transaction: async (fn, _options) => {
      const snap = snapshot();
      try {
        return await fn(tx);
      } catch (e) {
        restore(snap);
        throw e;
      }
    },
  };
}

const fixture: CaddyRow[] = [
  {
    id: 1,
    name: "이영진",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01011112222",
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
  {
    id: 2,
    name: "박서진",
    team: "9조",
    teamOrder: 3,
    employmentStatus: "LEAVE",
    phoneNormalized: "01022223333",
    thirdBandSubgroup: "WEEKDAY",
    caddyType: "THIRD",
  },
  {
    id: 3,
    name: "퇴사김",
    team: "2조",
    teamOrder: 4,
    employmentStatus: "RETIRED",
    phoneNormalized: null,
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
  {
    id: 4,
    name: "드라이브김",
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01055556666",
    thirdBandSubgroup: null,
    caddyType: "DRIVING",
  },
  {
    id: 5,
    name: "전환대상",
    team: "4조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01077778888",
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
];

const adminBuf = buildRosterExportXlsxBuffer(fixture, { canReadArchived: true });

async function applyOrCatch(input: {
  buffer: Buffer;
  rows: CaddyRow[];
  users?: UserRow[];
  throwOn?: "firstUpdate" | "create" | "retire" | "audit";
  fingerprint?: string;
  actorUserId?: number | null;
}) {
  const db = createApplyDb({
    caddies: cloneCaddies(input.rows),
    users: input.users,
    throwOn: input.throwOn,
  });
  const fingerprint =
    input.fingerprint ?? fingerprintRosterSnapshot([...db.caddies.values()]);
  try {
    const result = await applyXlsxV2Workbook(
      {
        buffer: input.buffer,
        fingerprint,
        canReadArchived: true,
        actorUserId: input.actorUserId ?? 99,
      },
      db
    );
    return { result, error: null as XlsxV2ApplyError | null, db };
  } catch (e) {
    return {
      result: null,
      error: e instanceof XlsxV2ApplyError ? e : null,
      raw: e,
      db,
    };
  }
}

async function main() {
  section("create 1");
  const createBuf = rebuild(adminBuf, (sheets) => {
    sheets["신규캐디"][1] = ["신규박", "1조", 8, "ACTIVE", "01099990000", "일반"];
  });
  const created = await applyOrCatch({ buffer: createBuf, rows: fixture });
  assert(created.result?.created === 1, "create count 1");
  assert(created.result?.createdIds.length === 1, "created id returned");
  const createdRow = [...created.db.caddies.values()].find((r) => r.name === "신규박");
  assert(createdRow?.team === "1조" && createdRow.teamOrder === 8, "create fields");
  assert(createdRow?.caddyType === "HOUSE", "create HOUSE from 1조");
  assert(createdRow?.phoneNormalized === "01099990000", "create phone");
  assert(created.db.caddies.get(1)?.name === "이영진", "omitted existing unchanged");

  section("update 1 — field-diff only");
  const updateBuf = rebuild(adminBuf, (sheets) => {
    const row = existingRow(sheets, 1);
    if (row) row[2] = "3조";
  });
  const updated = await applyOrCatch({ buffer: updateBuf, rows: fixture });
  assert(updated.result?.updated === 1, "update count 1");
  assert(updated.result?.updatedIds[0] === 1, "updated id 1");
  const afterUpdate = updated.db.caddies.get(1);
  assert(afterUpdate?.team === "3조", "team changed");
  assert(afterUpdate?.caddyType === "HOUSE", "caddyType stays HOUSE");
  assert(afterUpdate?.name === "이영진", "name not overwritten");
  assert(afterUpdate?.phoneNormalized === "01011112222", "phone not overwritten");
  assert(afterUpdate?.teamOrder === 1, "teamOrder not overwritten");
  assert(updated.db.caddies.get(2)?.team === "9조", "id 2 omitted unchanged");

  section("retire 1 + linked User sessionVersion");
  const retireBuf = rebuild(adminBuf, (sheets) => {
    sheets["기존캐디"] = sheets["기존캐디"].filter(
      (r, i) => i === 0 || Number(r[0]) !== 2
    );
    sheets["퇴사"][1] = [2, "박서진", "이직"];
  });
  const retired = await applyOrCatch({
    buffer: retireBuf,
    rows: fixture,
    users: [
      { id: 10, caddyId: 2, sessionVersion: 3 },
      { id: 11, caddyId: 1, sessionVersion: 1 },
    ],
  });
  assert(retired.result?.retired === 1, "retire count 1");
  assert(retired.result?.retiredIds[0] === 2, "retired id 2");
  assert(retired.db.caddies.get(2)?.employmentStatus === "RETIRED", "soft retire");
  assert(retired.db.caddies.has(2), "caddy not physically deleted");
  assert(retired.db.users.has(10), "linked User not deleted");
  assert(retired.db.users.get(10)?.sessionVersion === 4, "linked sessionVersion +1");
  assert(retired.db.users.get(11)?.sessionVersion === 1, "other User session untouched");
  assert(retired.result?.sessionsRevoked === 1, "sessionsRevoked 1");
  assert(
    employmentBecameRetired("LEAVE", "RETIRED") === true,
    "retire policy helper matches PATCH/DELETE"
  );
  assert(
    employmentBecameRetired("RETIRED", "RETIRED") === false,
    "already RETIRED does not revoke again"
  );

  section("driving change — persist fields, no extra caddy");
  const drivingUpdateBuf = rebuild(adminBuf, (sheets) => {
    sheets["드라이빙"] = sheets["드라이빙"].map((row, i) =>
      i > 0 && Number(row[0]) === 4 ? [4, "드라이브김", "01055550000", "ACTIVE"] : row
    );
  });
  const drivingUpdated = await applyOrCatch({
    buffer: drivingUpdateBuf,
    rows: fixture,
  });
  assert(drivingUpdated.result?.drivingChanged === 1, "driving change 1");
  assert(drivingUpdated.result?.drivingIds[0] === 4, "driving id 4");
  assert(
    drivingUpdated.db.caddies.get(4)?.phoneNormalized === "01055550000",
    "driving phone updated"
  );
  assert(drivingUpdated.db.caddies.get(4)?.caddyType === "DRIVING", "still DRIVING");
  assert(
    [...drivingUpdated.db.caddies.values()].filter((r) => r.name === "드라이브김")
      .length === 1,
    "no duplicate driving caddy"
  );

  const convertBuf = rebuild(adminBuf, (sheets) => {
    sheets["기존캐디"] = sheets["기존캐디"].filter(
      (r, i) => i === 0 || Number(r[0]) !== 5
    );
    sheets["드라이빙"].push([5, "전환대상", "01077778888", "ACTIVE"]);
  });
  const converted = await applyOrCatch({ buffer: convertBuf, rows: fixture });
  const driving = drivingPersistFields();
  assert(converted.result?.drivingChanged === 1, "convert_to_driving count");
  assert(converted.db.caddies.get(5)?.team === driving.team, "convert team");
  assert(converted.db.caddies.get(5)?.teamOrder === driving.teamOrder, "convert order");
  assert(converted.db.caddies.get(5)?.caddyType === "DRIVING", "convert type");
  assert(converted.db.caddies.get(5)?.thirdBandSubgroup == null, "convert subgroup null");
  assert(converted.db.caddies.size === fixture.length, "convert does not create extra row");

  section("mixed batch success + audit");
  const mixedBuf = rebuild(adminBuf, (sheets) => {
    sheets["기존캐디"] = sheets["기존캐디"].filter(
      (r, i) => i === 0 || Number(r[0]) !== 2
    );
    const row = existingRow(sheets, 1);
    if (row) row[2] = "3조";
    sheets["신규캐디"][1] = ["신규박", "1조", 8, "ACTIVE", "", "일반"];
    sheets["퇴사"][1] = [2, "박서진", ""];
    sheets["드라이빙"] = sheets["드라이빙"].map((r, i) =>
      i > 0 && Number(r[0]) === 4 ? [4, "드라이브김", "01055550000", "ACTIVE"] : r
    );
  });
  const mixed = await applyOrCatch({
    buffer: mixedBuf,
    rows: fixture,
    users: [{ id: 10, caddyId: 2, sessionVersion: 1 }],
    actorUserId: 77,
  });
  assert(mixed.result?.created === 1, "mixed create");
  assert(mixed.result?.updated === 1, "mixed update");
  assert(mixed.result?.retired === 1, "mixed retire");
  assert(mixed.result?.drivingChanged === 1, "mixed driving");
  assert(mixed.db.caddies.get(3)?.employmentStatus === "RETIRED", "omitted retired stays");
  assert(mixed.db.caddies.get(5)?.team === "4조", "omitted house unchanged");
  assert(mixed.db.audits.length === 1, "one audit row");
  const payload = mixed.db.audits[0]?.data.payload as Record<string, unknown>;
  assert(payload?.source === "xlsx_v2", "audit source xlsx_v2");
  assert(payload?.actorUserId === 77, "audit actor");
  assert(payload?.created === 1 && payload?.updated === 1, "audit counts");
  assert(Array.isArray(payload?.retiredIds), "audit affected ids");
  const leaked = JSON.stringify(payload);
  assert(!/password/i.test(leaked), "audit has no password");
  assert(mixed.db.audits[0]?.data.action === "IMPORT_CADDIES_XLSX_V2", "audit action");

  section("validation error → DB write 0");
  const badBuf = rebuild(adminBuf, (sheets) => {
    const row = existingRow(sheets, 1);
    if (row) row[2] = "13조";
  });
  const bad = await applyOrCatch({ buffer: badBuf, rows: fixture });
  assert(bad.error?.code === "preview_errors", "validation blocks apply");
  assert(bad.error?.status === 400, "400 on preview errors");
  assert(bad.db.writeAttempts.update === 0, "no update write");
  assert(bad.db.writeAttempts.create === 0, "no create write");
  assert(bad.db.writeAttempts.retire === 0, "no retire write");
  assert(bad.db.writeAttempts.audit === 0, "no audit write");
  assert(bad.db.caddies.get(1)?.team === "1조", "row unchanged");

  section("duplicate phone blocked before write");
  const dupPhoneBuf = rebuild(adminBuf, (sheets) => {
    const row = existingRow(sheets, 1);
    if (row) row[5] = "01022223333";
  });
  const dupPhone = await applyOrCatch({ buffer: dupPhoneBuf, rows: fixture });
  assert(
    dupPhone.error?.preview?.errors.some((e) => e.code === "duplicate_phone_in_db"),
    "duplicate phone is preview error"
  );
  assert(dupPhone.db.caddies.get(1)?.phoneNormalized === "01011112222", "phone unchanged");
  assert(dupPhone.db.writeAttempts.update === 0, "duplicate phone write 0");

  section("name-only row never matches");
  const nameOnlyBuf = rebuild(adminBuf, (sheets) => {
    sheets["기존캐디"].push(["", "이영진", "3조", 1, "ACTIVE", "", "일반"]);
  });
  const nameOnly = await applyOrCatch({ buffer: nameOnlyBuf, rows: fixture });
  assert(
    nameOnly.error?.preview?.errors.some((e) => e.code === "id_required"),
    "name-only existing row is error"
  );
  assert(nameOnly.db.caddies.get(1)?.team === "1조", "name-only did not update id 1");
  assert(nameOnly.db.writeAttempts.update === 0, "name-only write 0");

  section("stale/conflict → 409 + DB unchanged");
  const stalePreview = buildXlsxV2WorkbookPreview(updateBuf, fixture, {
    canReadArchived: true,
  });
  const staleRows = cloneCaddies(fixture);
  staleRows[0] = { ...staleRows[0], name: "이영진변경" };
  const stale = await applyOrCatch({
    buffer: updateBuf,
    rows: staleRows,
    fingerprint: stalePreview.confirmation.fingerprint,
  });
  assert(stale.error?.code === "stale_preview", "stale fingerprint");
  assert(stale.error?.status === 409, "409 conflict");
  assert(stale.db.caddies.get(1)?.team === "1조", "stale apply did not write team");
  assert(stale.db.caddies.get(1)?.name === "이영진변경", "live name kept");
  assert(stale.db.writeAttempts.update === 0, "stale write 0");

  section("중간 failure → full rollback");
  const rolled = await applyOrCatch({
    buffer: mixedBuf,
    rows: fixture,
    users: [{ id: 10, caddyId: 2, sessionVersion: 5 }],
    throwOn: "create",
  });
  assert(rolled.result == null, "mid failure throws");
  assert(rolled.db.caddies.get(1)?.team === "1조", "update rolled back");
  assert(rolled.db.caddies.get(2)?.employmentStatus === "LEAVE", "retire rolled back");
  assert(rolled.db.caddies.get(4)?.phoneNormalized === "01055556666", "driving rolled back");
  assert(
    [...rolled.db.caddies.values()].every((r) => r.name !== "신규박"),
    "create not persisted"
  );
  assert(rolled.db.users.get(10)?.sessionVersion === 5, "session increment rolled back");
  assert(rolled.db.audits.length === 0, "audit rolled back");
  assert(rolled.db.caddies.size === fixture.length, "row count unchanged after rollback");

  section("omitted caddy unchanged on apply");
  const omitBuf = rebuild(adminBuf, (sheets) => {
    sheets["기존캐디"] = sheets["기존캐디"].filter(
      (r, i) => i === 0 || Number(r[0]) !== 2
    );
    const row = existingRow(sheets, 1);
    if (row) row[2] = "3조";
  });
  const omitted = await applyOrCatch({ buffer: omitBuf, rows: fixture });
  assert(omitted.result?.updated === 1, "omitted file still updates present id");
  assert(omitted.db.caddies.get(2)?.employmentStatus === "LEAVE", "omitted not retired");
  assert(omitted.db.caddies.get(2)?.team === "9조", "omitted fields same");

  section("P1 export → P2 preview → P3 apply e2e (local mock)");
  const e2eExisting = cloneCaddies(fixture);
  const exported = buildRosterExportXlsxBuffer(e2eExisting, { canReadArchived: true });
  const e2eFile = rebuild(exported, (sheets) => {
    sheets["기존캐디"] = sheets["기존캐디"].filter(
      (r, i) => i === 0 || Number(r[0]) !== 5
    );
    const row = existingRow(sheets, 1);
    if (row) row[2] = "3조";
    sheets["신규캐디"][1] = ["엔드투엔드", "2조", 1, "ACTIVE", "", "일반"];
    sheets["퇴사"][1] = [5, "전환대상", "전환 전 퇴사 아님"];
  });
  const e2ePreview = buildXlsxV2WorkbookPreview(e2eFile, e2eExisting, {
    canReadArchived: true,
  });
  assert(e2ePreview.summary.applyAvailable === true, "e2e preview applyAvailable");
  assert(e2ePreview.errors.length === 0, "e2e preview clean");
  const e2e = await applyOrCatch({
    buffer: e2eFile,
    rows: e2eExisting,
    fingerprint: e2ePreview.confirmation.fingerprint,
  });
  assert(e2e.result?.ok === true, "e2e apply ok");
  assert(e2e.result?.updated === 1 && e2e.result.created === 1, "e2e update+create");
  assert(e2e.result?.retired === 1, "e2e retire");
  assert(e2e.db.caddies.get(1)?.team === "3조", "e2e team applied");
  assert(
    [...e2e.db.caddies.values()].some((r) => r.name === "엔드투엔드"),
    "e2e create applied"
  );
  assert(e2e.db.caddies.get(5)?.employmentStatus === "RETIRED", "e2e retire applied");

  section("nothing to apply");
  const noop = await applyOrCatch({ buffer: adminBuf, rows: fixture });
  assert(noop.error?.code === "nothing_to_apply", "reupload is not applied");
  assert(noop.db.writeAttempts.update === 0, "noop write 0");

  section("source: apply route / UI / no hard delete");
  const applyRoute = readSrc("src/app/api/caddies/import-v2/xlsx/apply/route.ts");
  const applyLib = readSrc("lib/caddyRosterImportXlsxV2Apply.ts");
  const page = readSrc("src/app/manage/caddies/page.tsx");
  const previewRoute = readSrc(
    "src/app/api/caddies/import-v2/xlsx/preview/route.ts"
  );
  assert(/requireAdmin/.test(applyRoute), "apply requireAdmin");
  assert(/applyXlsxV2Workbook/.test(applyRoute), "apply uses engine");
  assert(/fingerprint/.test(applyRoute), "apply reads fingerprint");
  assert(!/prisma\.caddy\.delete/.test(applyRoute), "apply route no caddy.delete");
  assert(!/prisma\.user\.delete/.test(applyRoute), "apply route no user.delete");
  assert(!/caddy\.delete/.test(applyLib), "engine no caddy.delete");
  assert(!/user\.delete/.test(applyLib), "engine no user.delete");
  assert(/incrementSessionVersionForCaddyLink/.test(applyLib), "engine revokes session");
  assert(/\$transaction/.test(applyLib), "single transaction");
  assert(
    /await notifyChatSessionRevokedForCaddyLink/.test(applyLib),
    "engine awaits revoke after commit"
  );
  assert(
    !/void notifyChatSessionRevokedForCaddyLink/.test(applyLib),
    "engine revoke is not fire-and-forget"
  );
  assert(
    applyLib.indexOf("await db.$transaction") <
      applyLib.indexOf("await notifyChatSessionRevokedForCaddyLink"),
    "engine notify is after the transaction"
  );
  assert(/IMPORT_CADDIES_XLSX_V2/.test(applyLib), "audit action");
  assert(/xlsx_v2/.test(applyLib), "audit source");
  assert(/\/api\/caddies\/import-v2\/xlsx\/apply/.test(page), "UI posts apply");
  assert(/변경사항 적용/.test(page), "UI apply label");
  assert(/생성 \$\{/.test(page) && /드라이빙 변경/.test(page), "UI confirm counts");
  assert(/applyAvailable/.test(page), "UI gated by applyAvailable");
  assert(/!confirm\(confirmText\)/.test(page), "UI requires confirm");
  assert(
    !/prisma\.caddy\.(create|update|delete)/.test(previewRoute),
    "preview still read-only"
  );

  section("기존 CSV/import 회귀");
  const csvRoute = readSrc("src/app/api/caddies/export/route.ts");
  const oldPreview = readSrc("src/app/api/caddies/import/preview/route.ts");
  const oldApply = readSrc("src/app/api/caddies/import/apply/route.ts");
  const importV2 = readSrc("lib/caddyRosterImportV2.ts");
  assert(/buildRosterExportCsv/.test(csvRoute), "CSV export symbol");
  assert(
    !/caddyRosterImportXlsxV2Apply/.test(oldPreview) &&
      !/caddyRosterImportXlsxV2Apply/.test(oldApply) &&
      !/caddyRosterImportXlsxV2Apply/.test(importV2),
    "legacy import engine does not import xlsx v2 apply"
  );
  assert(/applyRosterImportPayloadV2/.test(oldApply), "legacy apply still v2");
  const csv = buildRosterExportCsv(fixture);
  assert(csv.includes("이영진") && !csv.includes("드라이브김"), "CSV still regular-only");

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
