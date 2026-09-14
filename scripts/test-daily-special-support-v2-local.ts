/**
 * LOCAL POSTGRESQL ONLY — 지원근무 V2 저장/조회/sortOrder/legacy PUT
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *   npx tsx scripts/test-daily-special-support-v2-local.ts
 */
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { seedOffSheetCacheForTests, setPublishedOffSheetLoaderForTests } from "../src/lib/offSheetFetch";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  DAILY_SPECIAL_SUPPORT_KINDS,
  DAILY_SPECIAL_SUPPORT_WORK_PATTERNS,
  shiftCompatFromWorkPattern,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
} from "../src/lib/dailySpecialSupport";
import {
  buildDailySpecialSupportPayload,
  deleteDailySpecialSupport,
  loadSpecialSupportQueuesForDate,
  listDailySpecialSupportRecords,
  moveDailySpecialSupport,
  replaceDailySpecialSupportGroup,
  replaceDailySpecialSupports,
} from "../src/lib/dailySpecialSupportService";

const TAG = "__SV2UI__";
const DATE = "2099-12-14";
const prisma = new PrismaClient();

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

async function cleanup(ids: number[]) {
  const { start } = parseYmd(DATE);
  await prisma.dailySpecialSupport.deleteMany({
    where: { OR: [{ caddyId: { in: ids } }, { date: start }] },
  });
  await prisma.assignment.deleteMany({
    where: { caddyId: { in: ids } },
  });
  await prisma.caddy.deleteMany({
    where: { id: { in: ids } },
  });
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const existingKinds = await prisma.$queryRaw<Array<{ kind: string }>>`
    SELECT DISTINCT kind::text AS kind FROM "DailySpecialSupport"
  `.catch(() => []);
  section("기존 schema / 특수지원 조회 호환");
  {
    const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'DailySpecialSupport'
        AND column_name IN ('kind', 'workPattern', 'sortOrder', 'shift')
      ORDER BY column_name
    `;
    const names = cols.map((c) => c.column_name);
    assert(names.includes("kind"), "kind 컬럼 존재");
    assert(names.includes("workPattern"), "workPattern 컬럼 존재");
    assert(names.includes("sortOrder"), "sortOrder 컬럼 존재");
    assert(names.includes("shift"), "기존 shift 컬럼 유지");
    const localLegacy = await prisma.dailySpecialSupport.findMany({
      where: { kind: "SPECIAL_SUPPORT" },
      take: 20,
    });
    assert(
      localLegacy.every((row) => row.kind === "SPECIAL_SUPPORT"),
      `로컬 SPECIAL_SUPPORT ${localLegacy.length}건 조회`
    );
    if (existingKinds.length) {
      assert(
        existingKinds.every(
          (row) =>
            !row.kind ||
            DAILY_SPECIAL_SUPPORT_KINDS.includes(
              row.kind as DailySpecialSupportKind
            )
        ),
        "기존 kind enum 값 유지"
      );
    }
  }

  const created = await prisma.caddy.createManyAndReturn({
    data: Array.from({ length: 8 }, (_, i) => ({
      name: `${TAG}${i + 1}`,
      team: "7조",
      teamOrder: i + 1,
      employmentStatus: "ACTIVE" as const,
      extraFlags: ["OFF"],
    })),
  });
  const ids = created.map((c) => c.id);
  const sheet = {
    name: "1214",
    matrix: [
      ["2099.12.14 (월)", "", "", "", "", "", "", ""],
      ["1조", "2조", "3조", "4조", "5조", "6조", "7조", "8조"],
      created.map((c) => c.name),
    ],
  };
  seedOffSheetCacheForTests([sheet]);
  setPublishedOffSheetLoaderForTests(async () => [sheet]);
  const { start, end } = parseYmd(DATE);
  await prisma.assignment.createMany({
    data: created.map((c) => ({
      caddyId: c.id,
      type: "OFF" as const,
      startDate: start,
      endDate: end,
    })),
  });

  try {
    section("6 kind + 5 workPattern 저장/조회");
    {
      const pairs: Array<[DailySpecialSupportKind, DailySpecialSupportWorkPattern]> =
        [
          ["CHAGEUN", "SHIFT_2"],
          ["SPECIAL_SUPPORT", "SHIFT_1"],
          ["OFF_SUPPORT", "ONE_TWO"],
          ["MARSHAL_SUPPORT", "SHIFT_3"],
          ["LEADER_SUPPORT", "SHIFT_1"],
          ["FIFTY_FOUR_SUPPORT", "FIFTY_FOUR"],
        ];
      for (let i = 0; i < pairs.length; i++) {
        const [kind, workPattern] = pairs[i]!;
        await replaceDailySpecialSupportGroup({
          date: DATE,
          kind,
          workPattern,
          caddyIds: [ids[i]!],
        });
      }
      const payload = await buildDailySpecialSupportPayload(DATE);
      const kindsSaved = new Set(payload.items.map((row) => row.kind));
      for (const kind of DAILY_SPECIAL_SUPPORT_KINDS) {
        assert(kindsSaved.has(kind), `${kind} 저장/조회`);
      }
      const patternsSaved = new Set(payload.items.map((row) => row.workPattern));
      for (const pattern of DAILY_SPECIAL_SUPPORT_WORK_PATTERNS) {
        assert(patternsSaved.has(pattern), `${pattern} 저장/조회`);
      }
      const oneTwo = payload.items.find((row) => row.workPattern === "ONE_TWO");
      const fiftyFour = payload.items.find(
        (row) => row.workPattern === "FIFTY_FOUR"
      );
      assert(oneTwo?.shift === "1·2부", "ONE_TWO shift 호환값");
      assert(fiftyFour?.shift === "54", "FIFTY_FOUR shift 호환값");
      assert(
        payload.byKindPattern?.SPECIAL_SUPPORT.SHIFT_1.length === 1,
        "byKindPattern 그룹"
      );
    }

    section("sortOrder 위/아래/삭제");
    {
      await replaceDailySpecialSupportGroup({
        date: DATE,
        kind: "SPECIAL_SUPPORT",
        workPattern: "SHIFT_1",
        caddyIds: [ids[1]!, ids[6]!, ids[7]!],
      });
      const before = (
        await listDailySpecialSupportRecords(DATE)
      ).filter(
        (row) =>
          row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        before.map((row) => row.caddyId).join(",") ===
          `${ids[1]},${ids[6]},${ids[7]}`,
        "등록 순서 저장"
      );
      const middle = before[1]!;
      await moveDailySpecialSupport(middle.id!, "up");
      const afterUp = (
        await listDailySpecialSupportRecords(DATE)
      ).filter(
        (row) =>
          row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        afterUp.map((row) => row.caddyId).join(",") ===
          `${ids[6]},${ids[1]},${ids[7]}`,
        "위로 이동"
      );
      await moveDailySpecialSupport(afterUp[0]!.id!, "down");
      const afterDown = (
        await listDailySpecialSupportRecords(DATE)
      ).filter(
        (row) =>
          row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        afterDown.map((row) => row.caddyId).join(",") ===
          `${ids[1]},${ids[6]},${ids[7]}`,
        "아래로 이동"
      );
      await deleteDailySpecialSupport(afterDown[2]!.id!);
      const afterDel = (
        await listDailySpecialSupportRecords(DATE)
      ).filter(
        (row) =>
          row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        afterDel.map((row) => row.caddyId).join(",") === `${ids[1]},${ids[6]}`,
        "삭제 후 잔여"
      );
      assert(
        afterDel.map((row) => row.sortOrder).join(",") === "1,2",
        "삭제 후 sortOrder 재번호"
      );
    }

    section("legacy PUT 호환 / 엔진 큐");
    {
      const chageunBefore = (await listDailySpecialSupportRecords(DATE)).filter(
        (row) => row.kind === "CHAGEUN"
      );
      assert(chageunBefore.length === 1, "legacy PUT 전 찾근 유지 대상");
      await replaceDailySpecialSupports({
        date: DATE,
        shift: "1부",
        caddyIds: [ids[1]!],
      });
      const afterLegacy = await listDailySpecialSupportRecords(DATE);
      const specialShift1 = afterLegacy.filter(
        (row) =>
          row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        specialShift1.map((row) => row.caddyId).join(",") === `${ids[1]}`,
        "legacy PUT은 SPECIAL_SUPPORT 해당 부만 교체"
      );
      assert(
        afterLegacy.some((row) => row.kind === "CHAGEUN"),
        "legacy PUT이 다른 kind를 지우지 않음"
      );
      assert(
        afterLegacy.some((row) => row.kind === "OFF_SUPPORT"),
        "legacy PUT이 1·2부 휴무지원을 지우지 않음"
      );
      const queues = await loadSpecialSupportQueuesForDate(DATE);
      assert(
        queues["1부"].map((c) => c.id).join(",") === `${ids[1]}`,
        "엔진 큐는 SPECIAL_SUPPORT 1부만"
      );
      assert(queues["2부"].length === 0, "찾근 SHIFT_2는 엔진에 넣지 않음");
      assert(
        queues["1부"][0]?.supportKind === "SPECIAL_SUPPORT" &&
          queues["1부"][0]?.supportWorkPattern === "SHIFT_1",
        "엔진 큐 표시 메타"
      );
      assert(
        shiftCompatFromWorkPattern("SHIFT_1") === "1부",
        "레거시 shift 호환 헬퍼"
      );
    }

    section("OFF_SUPPORT vs SPECIAL_SUPPORT 분리");
    {
      await replaceDailySpecialSupportGroup({
        date: DATE,
        kind: "SPECIAL_SUPPORT",
        workPattern: "SHIFT_1",
        caddyIds: [ids[1]!],
      });
      await replaceDailySpecialSupportGroup({
        date: DATE,
        kind: "OFF_SUPPORT",
        workPattern: "SHIFT_1",
        caddyIds: [ids[6]!],
      });
      const both = await listDailySpecialSupportRecords(DATE);
      const special = both.filter(
        (row) => row.kind === "SPECIAL_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      const offShift1 = both.filter(
        (row) => row.kind === "OFF_SUPPORT" && row.workPattern === "SHIFT_1"
      );
      assert(
        special.map((row) => row.caddyId).join(",") === `${ids[1]}`,
        "특수지원+1부 저장"
      );
      assert(
        offShift1.map((row) => row.caddyId).join(",") === `${ids[6]}`,
        "휴무지원+1부 저장"
      );
      assert(
        special[0]?.kind === "SPECIAL_SUPPORT" &&
          offShift1[0]?.kind === "OFF_SUPPORT",
        "두 kind가 캐디를 섞지 않음"
      );
      const payload = await buildDailySpecialSupportPayload(DATE);
      assert(
        (payload.countsByKind?.SPECIAL_SUPPORT || 0) >= 1 &&
          (payload.countsByKind?.OFF_SUPPORT || 0) >= 1,
        "종류 필터 카운트 분리"
      );
      assert(
        both.some((row) => row.kind === "SPECIAL_SUPPORT"),
        "기존 SPECIAL_SUPPORT 조회 유지"
      );

      await replaceDailySpecialSupportGroup({
        date: DATE,
        kind: "OFF_SUPPORT",
        workPattern: "SHIFT_1",
        caddyIds: [ids[1]!],
      });
      const afterMove = await listDailySpecialSupportRecords(DATE);
      const moved = afterMove.find((row) => row.caddyId === ids[1]);
      assert(
        moved?.kind === "OFF_SUPPORT" && moved.workPattern === "SHIFT_1",
        "같은 부 다른 kind 저장은 요청 kind로 이동"
      );
      assert(
        !afterMove.some(
          (row) => row.caddyId === ids[1] && row.kind === "SPECIAL_SUPPORT"
        ),
        "이동 후 특수로 남지 않음"
      );
    }
  } finally {
    setPublishedOffSheetLoaderForTests(null);
    await cleanup(ids);
    await prisma.$disconnect();
  }

  console.log(`\nOK ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try {
    setPublishedOffSheetLoaderForTests(null);
    const leftover = await prisma.caddy.findMany({
      where: { name: { startsWith: TAG } },
      select: { id: true },
    });
    const leftoverIds = leftover.map((row) => row.id);
    if (leftoverIds.length) {
      await prisma.dailySpecialSupport.deleteMany({
        where: { caddyId: { in: leftoverIds } },
      });
      await prisma.assignment.deleteMany({
        where: { caddyId: { in: leftoverIds } },
      });
      await prisma.caddy.deleteMany({ where: { id: { in: leftoverIds } } });
    }
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
  process.exit(1);
});
