/**
 * LOCAL POSTGRESQL ONLY — real batch SQL / transaction integration test.
 *
 * DATABASE_URL=postgresql://...localhost... npm run test:roster-import-v2-db
 */
import { Prisma, PrismaClient } from "@prisma/client";
import {
  applyRosterImportPayloadV2,
  RosterImportApplyError,
  type RosterExisting,
} from "../lib/caddyRosterImportV2";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

const TAG = "__IMPORT_V2_BATCH_TEST__";
const prisma = new PrismaClient({
  log: [{ emit: "event", level: "query" }],
});
const observedQueries: string[] = [];
let observe = false;

prisma.$on("query", (event) => {
  if (observe) observedQueries.push(event.query.trim());
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log("✓", message);
}

function localDatabaseOnly() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
}

function phoneFor(i: number): string {
  return `010${String(20_000_000 + i).padStart(8, "0")}`;
}

function writeCounts() {
  return {
    update: observedQueries.filter((q) => /^UPDATE\s+"Caddy"\s+AS\s+c/i.test(q))
      .length,
    insert: observedQueries.filter((q) => /^INSERT\s+INTO\s+/i.test(q)).length,
  };
}

async function observeApply<T>(run: () => Promise<T>): Promise<T> {
  observedQueries.length = 0;
  observe = true;
  try {
    return await run();
  } finally {
    observe = false;
  }
}

function asExisting(
  rows: Array<{
    id: number;
    name: string;
    team: string;
    teamOrder: number;
    employmentStatus: string;
    phoneNormalized: string | null;
    thirdBandSubgroup: "WEEKDAY" | "WEEKEND" | null;
  }>
): RosterExisting[] {
  return rows.map((row) => ({ ...row }));
}

async function main() {
  localDatabaseOnly();
  await prisma.caddy.deleteMany({ where: { name: { startsWith: TAG } } });

  try {
    const updateRows = await prisma.caddy.createManyAndReturn({
      data: Array.from({ length: 175 }, (_, i) => ({
        name: `${TAG}UPDATE-${i}`,
        team: `${TAG}TEAM-${i % 12}`,
        teamOrder: Math.floor(i / 12) + 1,
        employmentStatus: "ACTIVE" as const,
      })),
      select: {
        id: true,
        name: true,
        team: true,
        teamOrder: true,
        employmentStatus: true,
        phoneNormalized: true,
        thirdBandSubgroup: true,
        updatedAt: true,
      },
    });
    const updateExisting = asExisting(updateRows);
    const oldestBefore = Math.min(
      ...updateRows.map((row) => row.updatedAt.getTime())
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updateResult = await observeApply(() =>
      applyRosterImportPayloadV2(
        {
          updates: updateRows.map((row, i) => ({
            id: row.id,
            phone: phoneFor(i),
          })),
          creates: [],
        },
        prisma,
        { existingForGuard: updateExisting }
      )
    );
    const updateWrites = writeCounts();
    const updatedRows = await prisma.caddy.findMany({
      where: { name: { startsWith: `${TAG}UPDATE-` } },
      select: { phoneNormalized: true, updatedAt: true },
    });
    assert(updateResult.updated === 175, "175 updates applied");
    assert(
      updateWrites.update === 1 && updateWrites.insert === 0,
      "175 updates execute as one UPDATE statement"
    );
    assert(
      updatedRows.every(
        (row) =>
          row.phoneNormalized != null &&
          row.updatedAt.getTime() > oldestBefore
      ),
      "batch UPDATE refreshes updatedAt for every target"
    );

    const createResult = await observeApply(() =>
      applyRosterImportPayloadV2(
        {
          updates: [],
          creates: Array.from({ length: 88 }, (_, i) => ({
            name: `${TAG}CREATE-${i}`,
            team: `${TAG}CREATE-TEAM-${i % 8}`,
            teamOrder: Math.floor(i / 8) + 1,
            employmentStatus: "ACTIVE" as const,
          })),
        },
        prisma,
        { existingForGuard: updateExisting }
      )
    );
    const createWrites = writeCounts();
    assert(
      createResult.created === 88 && createResult.createdIds.length === 88,
      "88 creates return 88 generated ids"
    );
    assert(
      createWrites.update === 0 && createWrites.insert === 1,
      "88 creates execute as one createManyAndReturn INSERT"
    );
    const nullCreates = await prisma.caddy.count({
      where: {
        name: { startsWith: `${TAG}CREATE-` },
        phoneNormalized: null,
        thirdBandSubgroup: null,
      },
    });
    assert(nullCreates === 88, "create batch preserves null phone/subgroup");

    const mixedExistingRow = await prisma.caddy.create({
      data: {
        name: `${TAG}MIXED-EXISTING`,
        team: "9조",
        teamOrder: 24,
        employmentStatus: "RETIRED",
        thirdBandSubgroup: "WEEKDAY",
      },
    });
    const mixedExisting = asExisting([mixedExistingRow]);
    const mixedPayload = {
      updates: [
        {
          id: mixedExistingRow.id,
          thirdBandSubgroup: null,
        },
      ],
      creates: [
        {
          name: `${TAG}MIXED-CREATE`,
          team: `${TAG}MIXED-TEAM`,
          teamOrder: 1,
          employmentStatus: "ACTIVE" as const,
        },
      ],
    };
    const mixedResult = await observeApply(() =>
      applyRosterImportPayloadV2(mixedPayload, prisma, {
        existingForGuard: mixedExisting,
      })
    );
    const mixedWrites = writeCounts();
    const mixedAfter = await prisma.caddy.findUniqueOrThrow({
      where: { id: mixedExistingRow.id },
    });
    assert(
      mixedResult.updated === 1 &&
        mixedResult.created === 1 &&
        mixedWrites.update === 1 &&
        mixedWrites.insert === 1,
      "mixed apply uses one UPDATE plus one INSERT"
    );
    assert(
      mixedAfter.phoneNormalized == null &&
        mixedAfter.thirdBandSubgroup == null,
      "explicit null subgroup updates without changing null phone"
    );

    const rollbackExistingRow = await prisma.caddy.create({
      data: {
        name: `${TAG}ROLLBACK-EXISTING`,
        team: "10조",
        teamOrder: 24,
        employmentStatus: "RETIRED",
        thirdBandSubgroup: "WEEKEND",
      },
    });
    const rollbackExisting = asExisting([rollbackExistingRow]);
    const rollbackPrisma = {
      caddy: prisma.caddy,
      $executeRaw: (query: Prisma.Sql) => prisma.$executeRaw(query),
      $transaction: <T,>(
        fn: (tx: any) => Promise<T>,
        options?: { maxWait?: number; timeout?: number }
      ) =>
        prisma.$transaction(
          (tx) =>
            fn({
              caddy: {
                findMany: tx.caddy.findMany.bind(tx.caddy),
                createManyAndReturn: async () => {
                  throw new Error("forced create failure after batch update");
                },
              },
              $executeRaw: (query: Prisma.Sql) => tx.$executeRaw(query),
            }),
          options
        ),
    };
    try {
      await applyRosterImportPayloadV2(
        {
          updates: [
            { id: rollbackExistingRow.id, thirdBandSubgroup: null },
          ],
          creates: [
            {
              name: `${TAG}ROLLBACK-CREATE`,
              team: `${TAG}ROLLBACK-TEAM`,
              teamOrder: 1,
            },
          ],
        },
        rollbackPrisma as any,
        { existingForGuard: rollbackExisting }
      );
      throw new Error("expected rollback apply to fail");
    } catch (error) {
      assert(
        error instanceof RosterImportApplyError &&
          error.code === "apply_failed",
        "transaction failure maps to apply_failed"
      );
    }
    const rollbackAfter = await prisma.caddy.findUniqueOrThrow({
      where: { id: rollbackExistingRow.id },
    });
    const rollbackCreated = await prisma.caddy.count({
      where: { name: `${TAG}ROLLBACK-CREATE` },
    });
    assert(
      rollbackAfter.thirdBandSubgroup === "WEEKEND" && rollbackCreated === 0,
      "create error rolls back preceding real batch UPDATE"
    );
  } finally {
    await prisma.caddy.deleteMany({ where: { name: { startsWith: TAG } } });
  }
}

main()
  .then(() => console.log("DONE: roster import batch DB integration PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
