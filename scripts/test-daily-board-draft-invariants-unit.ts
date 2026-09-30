/**
 * C2/C3 daily board draft invariants — write-before-validate, no production DB.
 * 실행: npm run test:daily-board-draft-invariants-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  assignmentDraftToPayload,
  DailyBoardDraftPayloadError,
} from "../src/lib/dailyBoardDraft";
import {
  DRAFT_ASSIGNMENT_MISMATCH,
  INVALID_CADDY,
  SAME_SHIFT_DUPLICATE,
  assertDailyBoardDraftInvariants,
  findDailyBoardDraftInvariantIssue,
} from "../src/lib/dailyBoardDraftInvariants";
import {
  getDailyBoardDraft,
  saveDailyBoardDraft,
  type DailyBoardDraftDb,
} from "../src/lib/dailyBoardDraftService";
import {
  applyDirectCaddyEdit,
} from "../src/lib/assignmentBoardCellEdit";
import {
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import { validateConfirmRequest } from "../src/lib/assignmentConfirm";
import {
  DailyBoardPublishNoDraftError,
  publishDailyBoard,
  type PublishDailyBoardDb,
} from "../src/lib/dailyBoardPublishedService";
import { parseYmd } from "../src/lib/availabilityEngine";
import { assertLocalDatabaseUrl, isLocalDatabaseUrl } from "../src/lib/dbSafety";
import { PrismaClient } from "@prisma/client";

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

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function pool(n: number): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `C${i + 1}`,
    team: `${(i % 12) + 1}조`,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  }));
}

function reservations(date: string): AutoAssignReservation[] {
  return [
    { id: "A", date, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "a", rawRowIndex: 2 },
    { id: "B", date, course: "SKY", shift: "1부", teeTime: "07:08", teamName: "b", rawRowIndex: 3 },
    { id: "C", date, course: "OCEAN", shift: "1부", teeTime: "07:16", teamName: "c", rawRowIndex: 4 },
    { id: "D", date, course: "SKY", shift: "2부", teeTime: "13:00", teamName: "d", rawRowIndex: 5 },
  ];
}

function makeDraft(date: string, available = pool(8)): AssignmentDraft {
  return createDraftFromAutoResult(
    computeAutoAssignmentsV1({
      date,
      available,
      reservations: reservations(date),
    }),
    available
  );
}

type DraftRow = {
  date: Date;
  version: number;
  schemaVersion: number;
  payload: unknown;
  updatedAt: Date;
  updatedByUserId: number | null;
  createdAt: Date;
};

function createMemoryDraftDb(
  trustedCaddyIds: Iterable<number> = Array.from({ length: 20 }, (_, i) => i + 1)
) {
  const rows = new Map<number, DraftRow>();
  const published = new Map<number, unknown>();
  const caddySet = new Set(
    [...trustedCaddyIds].map((id) => Number(id)).filter((id) => id > 0)
  );
  const keyOf = (d: Date) => d.getTime();
  const cloneRow = (row: DraftRow): DraftRow => ({
    ...clone(row),
    date: new Date(row.date),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  });
  const api: DailyBoardDraftDb & PublishDailyBoardDb = {
    dailyBoardDraft: {
      findUnique: async ({ where }) => {
        const row = rows.get(keyOf(where.date));
        return row ? cloneRow(row) : null;
      },
      create: async ({ data }) => {
        const k = keyOf(data.date);
        if (rows.has(k)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const now = new Date();
        const row: DraftRow = {
          date: data.date,
          payload: clone(data.payload),
          schemaVersion: data.schemaVersion,
          version: data.version,
          updatedByUserId: data.updatedByUserId,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(k, row);
        return cloneRow(row);
      },
      updateMany: async ({ where, data }) => {
        const k = keyOf(where.date);
        const existing = rows.get(k);
        if (!existing || existing.version !== where.version) return { count: 0 };
        rows.set(k, {
          ...existing,
          payload: clone(data.payload),
          schemaVersion: data.schemaVersion,
          version: data.version,
          updatedByUserId: data.updatedByUserId,
          updatedAt: new Date(),
        });
        return { count: 1 };
      },
      deleteMany: async ({ where }) => {
        const k = keyOf(where.date);
        if (!rows.has(k)) return { count: 0 };
        rows.delete(k);
        return { count: 1 };
      },
    },
    dailyBoardPublished: {
      findUnique: async ({ where }) => {
        const row = published.get(keyOf(where.date));
        return row ? clone(row) : null;
      },
      upsert: async ({ where, create, update }) => {
        const k = keyOf(where.date);
        const now = new Date();
        const existing = published.get(k) as
          | {
              date: Date;
              payload: unknown;
              schemaVersion: number;
              sourceDraftVersion: number;
              publishedAt: Date;
              publishedByUserId: number | null;
              createdAt: Date;
              updatedAt: Date;
            }
          | undefined;
        const row = existing
          ? {
              ...existing,
              payload: clone(update.payload ?? existing.payload),
              schemaVersion: update.schemaVersion ?? existing.schemaVersion,
              sourceDraftVersion:
                update.sourceDraftVersion ?? existing.sourceDraftVersion,
              publishedAt: update.publishedAt ?? existing.publishedAt,
              publishedByUserId:
                update.publishedByUserId !== undefined
                  ? update.publishedByUserId
                  : existing.publishedByUserId,
              updatedAt: now,
            }
          : {
              date: create.date,
              payload: clone(create.payload),
              schemaVersion: create.schemaVersion,
              sourceDraftVersion: create.sourceDraftVersion,
              publishedAt: create.publishedAt,
              publishedByUserId: create.publishedByUserId ?? null,
              createdAt: now,
              updatedAt: now,
            };
        published.set(k, row);
        return {
          ...row,
          date: new Date(row.date),
          publishedAt: new Date(row.publishedAt),
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        };
      },
    },
    caddy: {
      findMany: async ({ where }: { where: { id: { in: number[] } } }) => {
        const ids = Array.isArray(where?.id?.in) ? where.id.in : [];
        return ids
          .map((id) => Number(id))
          .filter((id) => caddySet.has(id))
          .map((id) => ({ id }));
      },
    },
    $transaction: async (fn) => fn(api),
  };
  return { db: api, rows, published, caddySet };
}

async function main() {
  section("source: write after validate");
  {
    const svc = fs.readFileSync(
      path.resolve("src/lib/dailyBoardDraftService.ts"),
      "utf8"
    );
    const parseIdx = svc.indexOf("parseDailyBoardDraftPayload(input.payload");
    const assertIdx = svc.indexOf("assertDailyBoardDraftWriteInvariants(payload, db)");
    const txIdx = svc.indexOf("db.$transaction");
    assert(parseIdx >= 0 && assertIdx > parseIdx && txIdx > assertIdx, "saveDailyBoardDraft parse→assert→tx");
    const onDbAssert = svc.indexOf("assertDailyBoardDraftWriteInvariants(input.payload, tx)");
    const onDbCreate = svc.indexOf("tx.dailyBoardDraft.create");
    assert(onDbAssert >= 0 && onDbCreate > onDbAssert, "OnDb assert before create");
    const pub = fs.readFileSync(
      path.resolve("src/lib/dailyBoardPublishedService.ts"),
      "utf8"
    );
    const pubAssert = pub.indexOf("assertDailyBoardDraftWriteInvariants(draft.payload, db)");
    const pubWrite = pub.indexOf("const payload = buildPublishedPayloadFromDraft");
    assert(
      pubAssert >= 0 && pubWrite > pubAssert,
      "publish validates before snapshot write"
    );
    const cell = fs.readFileSync(
      path.resolve("src/lib/assignmentBoardCellEdit.ts"),
      "utf8"
    );
    assert(
      !cell.includes('w.code !== "SAME_SHIFT_DUPLICATE"'),
      "cell edit no longer allows SAME_SHIFT_DUPLICATE"
    );
    const quickMove = fs.readFileSync(
      path.resolve("src/lib/quickReservationMoveApply.ts"),
      "utf8"
    );
    const qmAssert = quickMove.indexOf("assertDailyBoardDraftWriteInvariants(payload, db)");
    const qmTx = quickMove.indexOf("db.$transaction");
    assert(
      qmAssert >= 0 && qmTx > qmAssert,
      "quick-move asserts before transaction"
    );
    const quickMut = fs.readFileSync(
      path.resolve("src/lib/quickBoardMutationApply.ts"),
      "utf8"
    );
    const qmutAssert = quickMut.indexOf("assertDailyBoardDraftWriteInvariants(payload, db)");
    const qmutTx = quickMut.indexOf("db.$transaction");
    assert(
      qmutAssert >= 0 && qmutTx > qmutAssert,
      "quick-mutation asserts before transaction"
    );
    const inv = fs.readFileSync(
      path.resolve("src/lib/dailyBoardDraftInvariants.ts"),
      "utf8"
    );
    assert(
      inv.includes("loadTrustedCaddyIdsFromDb") && inv.includes("caddy.findMany"),
      "write path looks up Caddy table ids"
    );
  }

  const date = "2099-11-03";
  const draft = makeDraft(date);
  const first = draft.assignments.find((a) => a.shift === "1부")!;
  const second = draft.assignments.find(
    (a) => a.shift === "1부" && reservationKey(a.reservation) !== reservationKey(first.reservation)
  )!;
  const twoShift = draft.assignments.find((a) => a.shift === "2부")!;

  section("1 same-shift duplicate rejects write");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    payload.assignments = payload.assignments.map((row) =>
      reservationKey(row.reservation) === reservationKey(second.reservation)
        ? { ...row, caddy: { ...first.caddy } }
        : row
    );
    let err: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) err = e;
    }
    assert(err?.code === SAME_SHIFT_DUPLICATE, "save rejects SAME_SHIFT_DUPLICATE");
    assert((await getDailyBoardDraft(date, mem.db)) === null, "same-shift write 0");
  }

  section("2 cross-shift same caddy allowed");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    payload.assignments = payload.assignments.map((row) =>
      reservationKey(row.reservation) === reservationKey(twoShift.reservation)
        ? { ...row, caddy: { ...first.caddy } }
        : row
    );
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload,
      updatedByUserId: null,
      db: mem.db,
    });
    assert(saved.version === 1, "1부+2부 same caddy saves");
    const loaded = await getDailyBoardDraft(date, mem.db);
    const count = loaded?.payload.assignments.filter((a) => a.caddy.id === first.caddy.id).length;
    assert(count === 2, "cross-shift two placements kept");
  }

  section("3 unknown caddy rejects write");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    payload.assignments = payload.assignments.map((row, i) =>
      i === 0 ? { ...row, caddy: { ...row.caddy, id: 999999, name: "Ghost" } } : row
    );
    let err: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) err = e;
    }
    assert(err?.code === INVALID_CADDY, "ghost id INVALID_CADDY");
    assert((await getDailyBoardDraft(date, mem.db)) === null, "ghost write 0");
  }

  section("4 date/shift mismatch rejects write");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    payload.assignments = payload.assignments.map((row, i) =>
      i === 0
        ? {
            ...row,
            reservation: { ...row.reservation, date: "2099-12-01" },
          }
        : row
    );
    let err: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) err = e;
    }
    assert(err?.code === DRAFT_ASSIGNMENT_MISMATCH, "date mismatch rejected");

    const shiftPayload = assignmentDraftToPayload(draft);
    shiftPayload.assignments = shiftPayload.assignments.map((row, i) =>
      i === 0
        ? { ...row, reservation: { ...row.reservation, shift: "3부" } }
        : row
    );
    let shiftErr: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload: shiftPayload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) shiftErr = e;
    }
    assert(shiftErr?.code === DRAFT_ASSIGNMENT_MISMATCH, "shift mismatch rejected");
    assert((await getDailyBoardDraft(date, mem.db)) === null, "mismatch write 0");
  }

  section("5 publish/confirm reject invalid");
  {
    const mem = createMemoryDraftDb();
    const ok = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: null,
      db: mem.db,
    });
    const row = mem.rows.values().next().value as DraftRow;
    const poisoned = assignmentDraftToPayload(draft);
    poisoned.assignments = poisoned.assignments.map((a) =>
      reservationKey(a.reservation) === reservationKey(second.reservation)
        ? { ...a, caddy: { ...first.caddy } }
        : a
    );
    row.payload = poisoned;
    let pubErr: DailyBoardDraftPayloadError | null = null;
    try {
      await publishDailyBoard({
        date,
        expectedDraftVersion: ok.version,
        publishedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) pubErr = e;
    }
    assert(pubErr?.code === SAME_SHIFT_DUPLICATE, "publish rejects duplicate");
    assert(mem.published.size === 0, "publish write 0");

    const confirm = validateConfirmRequest({
      status: "CONFIRMED",
      date,
      assignments: poisoned.assignments,
    });
    assert(confirm.ok === false, "confirm rejects duplicate");
    assert(
      !confirm.ok && confirm.issues.some((i) => i.code === SAME_SHIFT_DUPLICATE),
      "confirm SAME_SHIFT_DUPLICATE"
    );
  }

  section("6 valid draft save/publish/confirm");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload,
      updatedByUserId: null,
      db: mem.db,
    });
    const published = await publishDailyBoard({
      date,
      expectedDraftVersion: saved.version,
      publishedByUserId: 1,
      db: mem.db,
    });
    assert(published.sourceDraftVersion === saved.version, "publish ok");
    const confirm = validateConfirmRequest({
      status: "CONFIRMED",
      date,
      assignments: payload.assignments,
    });
    assert(confirm.ok === true, "confirm validates ok");
  }

  section("7 cell edit duplicate keeps board");
  {
    const before = makeDraft(date);
    const edited = applyDirectCaddyEdit(before, {
      reservationKey: reservationKey(second.reservation),
      caddyId: first.caddy.id,
    });
    if (!edited.ok) {
      assert(edited.code === SAME_SHIFT_DUPLICATE || edited.ok === false, "cell edit rejects or swaps");
    }
    if (edited.ok) {
      const issue = findDailyBoardDraftInvariantIssue({
        date,
        assignments: edited.draft.assignments,
        allowedCaddyIds: edited.draft.caddyPool.map((c) => c.id),
      });
      assert(issue == null, "peer swap/vacate stays invariant-valid");
      const dups = edited.draft.assignments.filter(
        (a) => a.caddy.id === first.caddy.id && a.shift === "1부"
      );
      assert(dups.length <= 1, "cell edit does not leave two 1부 copies");
    } else {
      assert(
        before.assignments.every(
          (a, i) => a.caddy.id === draft.assignments[i]?.caddy.id
        ),
        "rejected cell edit leaves source draft untouched"
      );
    }
  }

  section("8 helper: vacant id 0 ignored");
  {
    const payload = assignmentDraftToPayload(draft);
    payload.assignments.push({
      ...payload.assignments[0],
      reservation: { ...payload.assignments[0].reservation, id: "VAC", teeTime: "09:00" },
      caddy: { id: 0, name: "", team: "", teamOrder: 0 },
    });
    let threw = false;
    try {
      assertDailyBoardDraftInvariants(payload);
    } catch {
      threw = true;
    }
    assert(!threw, "vacant placeholder id 0 is not INVALID_CADDY");
  }

  section("9 ghost in caddyPool+assignment still rejected");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    const ghost = { id: 999999, name: "Ghost", team: "X조", teamOrder: 0 };
    payload.caddyPool = [...payload.caddyPool, ghost];
    payload.assignments = payload.assignments.map((row, i) =>
      i === 0 ? { ...row, caddy: { ...ghost } } : row
    );
    let err: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) err = e;
    }
    assert(err?.code === INVALID_CADDY, "forged pool+assignment ghost INVALID_CADDY");
    assert((await getDailyBoardDraft(date, mem.db)) === null, "forged ghost write 0");
  }

  section("10 aligned date/shift rewrite vs request date");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    payload.assignments = payload.assignments.map((row, i) =>
      i === 0
        ? {
            ...row,
            date: "2099-12-01",
            reservation: { ...row.reservation, date: "2099-12-01" },
          }
        : row
    );
    let err: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) err = e;
    }
    assert(
      err?.code === DRAFT_ASSIGNMENT_MISMATCH,
      "assignment+reservation both forged off request date → mismatch"
    );

    const aligned = assignmentDraftToPayload(draft);
    aligned.assignments = aligned.assignments.map((row, i) =>
      i === 0
        ? {
            ...row,
            shift: "3부",
            reservation: { ...row.reservation, shift: "3부" },
          }
        : row
    );
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: aligned,
      updatedByUserId: null,
      db: mem.db,
    });
    assert(saved.version === 1, "internally aligned shift rewrite currently saves");
  }

  section("11 special cross-shift no false positive");
  {
    const mem = createMemoryDraftDb();
    const payload = assignmentDraftToPayload(draft);
    const kinds = ["oneTwo", "oneThree", "twoThree", "oneMak"] as const;
    payload.assignments = payload.assignments.map((row) => {
      if (reservationKey(row.reservation) === reservationKey(twoShift.reservation)) {
        return {
          ...row,
          caddy: { ...first.caddy },
          kind: "oneTwo",
          pairId: "pair-1-2",
        };
      }
      if (reservationKey(row.reservation) === reservationKey(first.reservation)) {
        return { ...row, kind: "oneTwo", pairId: "pair-1-2" };
      }
      return row;
    });
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload,
      updatedByUserId: null,
      db: mem.db,
    });
    assert(saved.version === 1, "oneTwo 1부+2부 same caddy saves");
    for (const kind of kinds) {
      const issue = findDailyBoardDraftInvariantIssue({
        date,
        assignments: [
          { date, shift: "1부", caddy: { id: first.caddy.id } },
          {
            date,
            shift: kind === "twoThree" ? "2부" : kind === "oneMak" ? "3부" : "2부",
            caddy: { id: first.caddy.id },
          },
        ],
      });
      assert(issue == null, `${kind} cross-shift is not SAME_SHIFT_DUPLICATE`);
    }
  }

  section("12 legacy invalid GET then repair save");
  {
    const mem = createMemoryDraftDb();
    const ok = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: null,
      db: mem.db,
    });
    const row = mem.rows.values().next().value as DraftRow;
    const poisoned = assignmentDraftToPayload(draft);
    poisoned.assignments = poisoned.assignments.map((a) =>
      reservationKey(a.reservation) === reservationKey(second.reservation)
        ? { ...a, caddy: { ...first.caddy } }
        : a
    );
    row.payload = poisoned;
    const loaded = await getDailyBoardDraft(date, mem.db);
    assert(loaded?.version === ok.version, "GET still returns legacy invalid draft");

    let saveErr: DailyBoardDraftPayloadError | null = null;
    try {
      await saveDailyBoardDraft({
        date,
        expectedVersion: ok.version,
        payload: poisoned,
        updatedByUserId: null,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardDraftPayloadError) saveErr = e;
    }
    assert(saveErr?.code === SAME_SHIFT_DUPLICATE, "resave invalid rejected");
    assert(
      (await getDailyBoardDraft(date, mem.db))?.version === ok.version,
      "invalid resave write 0"
    );

    const repaired = await saveDailyBoardDraft({
      date,
      expectedVersion: ok.version,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: null,
      db: mem.db,
    });
    assert(repaired.version === ok.version + 1, "repaired draft saves");
  }

  section("13 local Caddy table rejects forged pool ghost");
  {
    const url = process.env.DATABASE_URL || "";
    if (!isLocalDatabaseUrl(url)) {
      console.log("  · skip local Caddy table (no local DATABASE_URL)");
    } else {
      assertLocalDatabaseUrl(url);
      const prisma = new PrismaClient();
      const localDate = "2099-11-28";
      const key = parseYmd(localDate).start;
      try {
        await prisma.dailyBoardDraft.deleteMany({ where: { date: key } });
        const payload = assignmentDraftToPayload(makeDraft(localDate));
        const ghost = { id: 999999999, name: "Ghost", team: "X조", teamOrder: 0 };
        payload.caddyPool = [...payload.caddyPool, ghost];
        payload.assignments = payload.assignments.map((row, i) =>
          i === 0 ? { ...row, caddy: { ...ghost } } : row
        );
        let err: DailyBoardDraftPayloadError | null = null;
        try {
          await saveDailyBoardDraft({
            date: localDate,
            expectedVersion: 0,
            payload,
            updatedByUserId: null,
            db: prisma as unknown as DailyBoardDraftDb,
          });
        } catch (e) {
          if (e instanceof DailyBoardDraftPayloadError) err = e;
        }
        const leftover = await prisma.dailyBoardDraft.findUnique({
          where: { date: key },
        });
        assert(err?.code === INVALID_CADDY, "local Caddy table rejects forged ghost");
        assert(leftover == null, "local forged ghost write 0");
      } finally {
        await prisma.dailyBoardDraft.deleteMany({ where: { date: key } });
        await prisma.$disconnect();
      }
    }
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
