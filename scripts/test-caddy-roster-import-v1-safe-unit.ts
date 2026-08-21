/**
 * XLSX v1 안전 반영 단위 테스트 (DB 없음)
 * npx tsx scripts/test-caddy-roster-import-v1-safe-unit.ts
 */
import fs from "fs";
import path from "path";
import {
  applyXlsxV1SafePayload,
  buildXlsxV1SafePreview,
  XlsxV1SafeApplyError,
} from "../lib/caddyRosterImportV1Safe";
import {
  listV1ProjectedEmptySlots,
  v1SafeApplyReady,
  type V1SafeResolution,
} from "../src/lib/caddyRosterImportV1SafeShared";
import type { RosterExisting } from "../lib/caddyRosterImportV2";
import type { ImportRow } from "../lib/caddyImport";

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

type StoreRow = RosterExisting & {
  caddyType?: string;
  missingFromImport?: boolean;
};

function cloneStore(src: Map<number, StoreRow>): Map<number, StoreRow> {
  return new Map([...src.entries()].map(([k, v]) => [k, { ...v }]));
}

function createTransactionalPrisma(
  store: Map<number, StoreRow>,
  opts?: {
    throwOnUpdateId?: number;
    nextCreateId?: number;
    deleted?: { count: number };
    relationWrites?: { count: number };
  }
) {
  let nextCreateId = opts?.nextCreateId ?? 1000;
  const executeBatchUpdate = async (query: { values: readonly unknown[] }) => {
    const fieldsPerRow = 13;
    if (query.values.length % fieldsPerRow !== 0) {
      throw new Error("unexpected batch SQL parameter count");
    }
    let affected = 0;
    for (let i = 0; i < query.values.length; i += fieldsPerRow) {
      const [
        rawId,
        setTeam,
        team,
        setTeamOrder,
        teamOrder,
        setEmploymentStatus,
        employmentStatus,
        setPhone,
        phoneNormalized,
        setThirdBandSubgroup,
        thirdBandSubgroup,
        setCaddyType,
        caddyType,
      ] = query.values.slice(i, i + fieldsPerRow);
      const id = Number(rawId);
      if (opts?.throwOnUpdateId === id) {
        throw new Error("forced mid-transaction failure");
      }
      const row = store.get(id);
      if (!row) continue;
      if (setTeam) row.team = String(team);
      if (setTeamOrder) row.teamOrder = Number(teamOrder);
      if (setEmploymentStatus) row.employmentStatus = String(employmentStatus);
      if (setPhone) row.phoneNormalized = phoneNormalized as string;
      if (setThirdBandSubgroup) {
        row.thirdBandSubgroup =
          (thirdBandSubgroup as RosterExisting["thirdBandSubgroup"]) ?? null;
      }
      if (setCaddyType) row.caddyType = String(caddyType);
      affected++;
    }
    return affected;
  };

  const caddy = {
    findMany: async () => [...store.values()],
    createManyAndReturn: async ({
      data,
    }: {
      data: Record<string, unknown>[];
      select: { id: true };
    }) => {
      const rows: Array<{ id: number }> = [];
      for (const item of data) {
        const id = nextCreateId++;
        store.set(id, {
          id,
          name: String(item.name),
          team: String(item.team),
          teamOrder: Number(item.teamOrder) || 1,
          employmentStatus: String(item.employmentStatus || "ACTIVE"),
          phoneNormalized: (item.phoneNormalized as string) ?? null,
          thirdBandSubgroup:
            (item.thirdBandSubgroup as RosterExisting["thirdBandSubgroup"]) ??
            null,
          caddyType: item.caddyType != null ? String(item.caddyType) : undefined,
          missingFromImport: item.missingFromImport === true,
        });
        rows.push({ id });
      }
      return rows;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: { in: number[] } };
      data: { missingFromImport: boolean };
    }) => {
      let count = 0;
      for (const id of where.id.in) {
        const row = store.get(id);
        if (!row) continue;
        row.missingFromImport = data.missingFromImport;
        count++;
      }
      return { count };
    },
    delete: async () => {
      opts?.deleted && opts.deleted.count++;
      throw new Error("prisma.caddy.delete is forbidden");
    },
  };

  const forbidRelation = async () => {
    opts?.relationWrites && opts.relationWrites.count++;
    throw new Error("relation write forbidden");
  };

  async function transaction<T>(
    fn: (tx: unknown) => Promise<T>,
    _options?: { maxWait?: number; timeout?: number }
  ): Promise<T> {
    const snapshot = cloneStore(store);
    const tx = {
      caddy,
      $executeRaw: executeBatchUpdate,
      assignment: { update: forbidRelation, updateMany: forbidRelation },
      schedule: { update: forbidRelation, updateMany: forbidRelation },
      user: { update: forbidRelation, updateMany: forbidRelation },
    };
    try {
      return await fn(tx);
    } catch (e) {
      const rolled = cloneStore(snapshot);
      store.clear();
      for (const [k, v] of rolled) store.set(k, v);
      throw e;
    }
  }

  return {
    caddy,
    $executeRaw: executeBatchUpdate,
    $transaction: transaction,
    assignment: { update: forbidRelation, updateMany: forbidRelation },
    schedule: { update: forbidRelation, updateMany: forbidRelation },
    user: { update: forbidRelation, updateMany: forbidRelation },
  };
}

function rows(items: Array<{ name: string; team: string }>): ImportRow[] {
  return items.map((p, i) => ({ name: p.name, team: p.team, rowNumber: i + 1 }));
}

const existing: RosterExisting[] = [
  {
    id: 1,
    name: "이영진",
    team: "1조",
    teamOrder: 7,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01011112222",
  },
  {
    id: 2,
    name: "박서진",
    team: "1조",
    teamOrder: 2,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  },
  {
    id: 3,
    name: "휴직자",
    team: "1조",
    teamOrder: 3,
    employmentStatus: "LEAVE",
    phoneNormalized: null,
  },
  {
    id: 4,
    name: "퇴사자",
    team: "1조",
    teamOrder: 9,
    employmentStatus: "RETIRED",
    phoneNormalized: null,
  },
  {
    id: 5,
    name: "누락대상",
    team: "8조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  },
  {
    id: 6,
    name: "드라이브김",
    team: "드라이빙",
    teamOrder: 0,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
    caddyType: "DRIVING",
  },
  {
    id: 7,
    name: "최동일",
    team: "1조",
    teamOrder: 4,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  },
  {
    id: 8,
    name: "최동일",
    team: "2조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  },
  {
    id: 9,
    name: "박준형",
    team: "3조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  },
];

async function expectBlocked(
  fn: () => Promise<unknown>,
  needle: string,
  msg: string
) {
  try {
    await fn();
    assert(false, msg);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert(
      (e instanceof XlsxV1SafeApplyError || text.includes(needle)) &&
        text.includes(needle),
      msg
    );
  }
}

async function main() {
  section("preview: keep same team / file order is not teamOrder");
  const keepPreview = buildXlsxV1SafePreview(
    rows([
      { name: "신규자", team: "1조" },
      { name: "이영진", team: "1조" },
      { name: "주중만", team: "주중반" },
    ]),
    existing
  );
  const keepRow = keepPreview.rows.find((r) => r.name === "이영진");
  const createRow = keepPreview.rows.find((r) => r.name === "신규자");
  const extraRow = keepPreview.rows.find((r) => r.name === "주중만");
  assert(keepRow?.kind === "keep" && keepRow.currentId === 1, "same team exact match keeps id");
  assert(keepRow?.currentTeamOrder === 7, "existing teamOrder 7 kept; file order unused");
  assert(createRow?.kind === "create" && createRow.currentTeamOrder == null, "new name is create without auto teamOrder");
  assert(extraRow?.kind === "extraOnly", "extra-only is notice, not 1-12 create");
  assert(
    !keepPreview.importPeople.some((p) => p.team === "주중반"),
    "extra-only excluded from apply importPeople"
  );
  assert(
    keepPreview.missing.some((m) => m.id === 5) &&
      !keepPreview.missing.some((m) => m.id === 4) &&
      !keepPreview.missing.some((m) => m.id === 6),
    "missing = ACTIVE/LEAVE 1-12 not included; RETIRED/driving excluded"
  );
  assert(
    v1SafeApplyReady(keepPreview.rows).ready === false,
    "create without slot blocks apply"
  );

  section("preview: team move needs empty slot, leavers free old slot");
  const movePreview = buildXlsxV1SafePreview(
    rows([
      { name: "이영진", team: "1조" },
      { name: "박서진", team: "2조" },
      { name: "신규자", team: "1조" },
    ]),
    existing
  );
  const mover = movePreview.rows.find((r) => r.name === "박서진");
  assert(mover?.kind === "move" && mover.currentId === 2, "team change is move with same id");
  assert(mover?.currentTeamOrder === 2, "move does not carry old teamOrder as chosen slot");
  const mergedForSlots = movePreview.rows.map((r) =>
    r.name === "박서진" ? { ...r, teamOrder: 3 } : r
  );
  const slotsForNew = listV1ProjectedEmptySlots(
    movePreview.occupants,
    mergedForSlots,
    "1조",
    "신규자"
  );
  assert(slotsForNew.includes(2), "mover leaving 1조 2 frees that slot for others");
  assert(!slotsForNew.includes(7), "keep occupant still occupies 1조 7");
  assert(!slotsForNew.includes(3), "LEAVE still occupies slot");

  section("needsReview is unresolved until explicit choice");
  const reviewPreview = buildXlsxV1SafePreview(
    rows([{ name: "최동일", team: "1조" }]),
    existing
  );
  const review = reviewPreview.rows.find((r) => r.name === "최동일");
  assert(review?.kind === "needsReview", "duplicate name needsReview");
  assert(
    review?.candidates.some((c) => c.id === 7 && c.team === "1조" && c.teamOrder === 4) &&
      review?.candidates.some((c) => c.id === 8 && c.team === "2조" && c.teamOrder === 1),
    "needsReview shows candidate id/team/teamOrder"
  );
  assert(review?.currentId == null, "needsReview does not auto-select a candidate");
  assert(v1SafeApplyReady(reviewPreview.rows).ready === false, "unresolved needsReview blocks apply");

  const blockPreview = buildXlsxV1SafePreview(
    rows([{ name: "박준형", team: "1조" }]),
    existing
  );
  assert(
    blockPreview.rows.some((r) => r.name === "박준형" && r.kind === "needsReview"),
    "blocklisted name is needsReview, not auto create/merge"
  );

  section("apply: keep same team preserves id/teamOrder/phone");
  const keepStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const deleted = { count: 0 };
  const relationWrites = { count: 0 };
  const keepPrisma = createTransactionalPrisma(keepStore, {
    deleted,
    relationWrites,
    nextCreateId: 500,
  });
  const keepResult = await applyXlsxV1SafePayload(
    {
      importPeople: [{ name: "이영진", team: "1조" }],
      resolutions: [{ name: "이영진", teamOrder: 1, matchId: 999 }],
    },
    keepPrisma,
    { existingForGuard: existing }
  );
  assert(keepResult.updated === 0 && keepResult.created === 0, "keep does not update/create");
  assert(keepStore.get(1)?.id === 1 && keepStore.get(1)?.teamOrder === 7, "keep id/teamOrder unchanged");
  assert(keepStore.get(1)?.phoneNormalized === "01011112222", "keep does not touch phone");
  assert(keepStore.get(1)?.team === "1조", "keep team unchanged");
  assert(keepStore.get(1)?.missingFromImport === false, "included keep missingFromImport=false");
  assert(keepStore.get(5)?.missingFromImport === true, "unlisted ACTIVE flagged missingFromImport");
  assert(keepStore.get(4)?.missingFromImport !== true, "RETIRED not flagged missing");
  assert(keepStore.get(6)?.missingFromImport !== true, "driving not flagged missing");
  assert(keepStore.get(4)?.employmentStatus === "RETIRED", "missing not auto RETIRED — already retired stays");
  assert(keepStore.get(5)?.employmentStatus === "ACTIVE", "missing ACTIVE is not retired/deleted");
  assert(!keepStore.has(500), "keep does not create a new id");
  assert(deleted.count === 0 && relationWrites.count === 0, "no delete / Assignment/Schedule/User writes");

  section("apply: move without slot blocked; with slot keeps id");
  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [
            { name: "이영진", team: "1조" },
            { name: "박서진", team: "2조" },
          ],
          resolutions: [],
        },
        keepPrisma,
        { existingForGuard: existing }
      ),
    "순번",
    "move without slot is blocked"
  );
  const moveStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const movePrisma = createTransactionalPrisma(moveStore, { nextCreateId: 500 });
  const moveResult = await applyXlsxV1SafePayload(
    {
      importPeople: [
        { name: "이영진", team: "1조" },
        { name: "박서진", team: "2조" },
      ],
      resolutions: [{ name: "박서진", teamOrder: 3 }],
    },
    movePrisma,
    { existingForGuard: existing }
  );
  assert(moveResult.updated === 1 && moveResult.created === 0, "one move update");
  assert(moveStore.get(2)?.id === 2 && moveStore.get(2)?.team === "2조", "moved with same id");
  assert(moveStore.get(2)?.teamOrder === 3, "move uses admin slot, not file order");
  assert(moveStore.get(2)?.phoneNormalized == null, "move does not invent phone");

  section("apply: create without slot blocked; with slot new id");
  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [
            { name: "이영진", team: "1조" },
            { name: "신규자", team: "1조" },
          ],
        },
        movePrisma,
        { existingForGuard: existing }
      ),
    "순번",
    "create without slot is blocked"
  );
  const createStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const createPrisma = createTransactionalPrisma(createStore, { nextCreateId: 800 });
  const createResult = await applyXlsxV1SafePayload(
    {
      importPeople: [
        { name: "신규자", team: "1조" },
        { name: "이영진", team: "1조" },
      ],
      resolutions: [{ name: "신규자", teamOrder: 1 }],
    },
    createPrisma,
    { existingForGuard: existing }
  );
  assert(createResult.created === 1, "create with slot inserts");
  assert(createStore.get(800)?.name === "신규자" && createStore.get(800)?.team === "1조", "new id allocated at apply");
  assert(createStore.get(800)?.teamOrder === 1, "create uses selected slot, not file row 1 as order");
  assert(createStore.get(1)?.id === 1 && createStore.get(1)?.teamOrder === 7, "existing keep still id 1 order 7");
  assert(createStore.get(800)?.missingFromImport === false, "create missingFromImport=false");

  section("apply: needsReview unresolved / match same team / match other team / create");
  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        { importPeople: [{ name: "최동일", team: "1조" }] },
        createPrisma,
        { existingForGuard: existing }
      ),
    "검토필요",
    "unresolved needsReview blocked"
  );
  const reviewSameStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const reviewSamePrisma = createTransactionalPrisma(reviewSameStore);
  await applyXlsxV1SafePayload(
    {
      importPeople: [{ name: "최동일", team: "1조" }],
      resolutions: [{ name: "최동일", matchId: 7, teamOrder: 99 }],
    },
    reviewSamePrisma,
    { existingForGuard: existing }
  );
  assert(
    reviewSameStore.get(7)?.team === "1조" && reviewSameStore.get(7)?.teamOrder === 4,
    "needsReview same-team match keeps existing teamOrder (client 99 ignored)"
  );

  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [{ name: "최동일", team: "1조" }],
          resolutions: [{ name: "최동일", matchId: 8 }],
        },
        reviewSamePrisma,
        { existingForGuard: existing }
      ),
    "순번",
    "needsReview match to other team requires slot"
  );
  const reviewMoveStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const reviewMovePrisma = createTransactionalPrisma(reviewMoveStore);
  await applyXlsxV1SafePayload(
    {
      importPeople: [{ name: "최동일", team: "1조" }],
      resolutions: [{ name: "최동일", matchId: 8, teamOrder: 5 }],
    },
    reviewMovePrisma,
    { existingForGuard: existing }
  );
  assert(
    reviewMoveStore.get(8)?.team === "1조" && reviewMoveStore.get(8)?.teamOrder === 5,
    "needsReview other-team match moves same id into chosen slot"
  );
  assert(reviewMoveStore.get(7)?.team === "1조", "unselected duplicate remains");

  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [{ name: "박준형", team: "1조" }],
          resolutions: [{ name: "박준형", asCreate: true }],
        },
        reviewMovePrisma,
        { existingForGuard: existing }
      ),
    "순번",
    "needsReview explicit create requires slot"
  );
  const reviewCreateStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const reviewCreatePrisma = createTransactionalPrisma(reviewCreateStore, {
    nextCreateId: 900,
  });
  const reviewCreate = await applyXlsxV1SafePayload(
    {
      importPeople: [{ name: "박준형", team: "1조" }],
      resolutions: [{ name: "박준형", asCreate: true, teamOrder: 10 }],
    },
    reviewCreatePrisma,
    { existingForGuard: existing }
  );
  assert(reviewCreate.created === 1 && reviewCreateStore.get(900)?.name === "박준형", "explicit needsReview create allocates new id");
  assert(reviewCreateStore.get(9)?.id === 9 && reviewCreateStore.get(9)?.team === "3조", "existing blocklisted person not merged/deleted");

  section("duplicate slot choice and stale occupancy");
  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [
            { name: "박서진", team: "2조" },
            { name: "신규자", team: "2조" },
            { name: "이영진", team: "1조" },
          ],
          resolutions: [
            { name: "박서진", teamOrder: 4 },
            { name: "신규자", teamOrder: 4 },
          ],
        },
        reviewCreatePrisma,
        { existingForGuard: existing }
      ),
    "동시에 선택",
    "two rows choosing the same slot are blocked"
  );

  const stale = existing.map((e) => ({ ...e }));
  stale.push({
    id: 50,
    name: "중간점유",
    team: "2조",
    teamOrder: 3,
    employmentStatus: "ACTIVE",
    phoneNormalized: null,
  });
  const staleStore = cloneStore(new Map(stale.map((e) => [e.id, { ...e }])));
  await expectBlocked(
    () =>
      applyXlsxV1SafePayload(
        {
          importPeople: [
            { name: "이영진", team: "1조" },
            { name: "박서진", team: "2조" },
          ],
          resolutions: [{ name: "박서진", teamOrder: 3 }],
        },
        createTransactionalPrisma(staleStore),
        { existingForGuard: stale }
      ),
    "빈 슬롯이 아닙니다",
    "Apply revalidates occupancy after preview; occupied slot rolls back"
  );
  assert(
    staleStore.get(2)?.team === "1조" && staleStore.get(2)?.teamOrder === 2,
    "failed apply does not move the caddy"
  );

  section("mid-transaction failure rolls back");
  const failStore = cloneStore(new Map(existing.map((e) => [e.id, { ...e }])));
  const failPrisma = createTransactionalPrisma(failStore, { throwOnUpdateId: 2 });
  try {
    await applyXlsxV1SafePayload(
      {
        importPeople: [
          { name: "이영진", team: "1조" },
          { name: "박서진", team: "2조" },
        ],
        resolutions: [{ name: "박서진", teamOrder: 3 }],
      },
      failPrisma,
      { existingForGuard: existing }
    );
    assert(false, "forced failure should throw");
  } catch {
    assert(
      failStore.get(2)?.team === "1조" && failStore.get(2)?.teamOrder === 2,
      "transaction rollback restores pre-apply row"
    );
  }

  section("source / payload guards");
  const root = path.join(__dirname, "..");
  const v1Src = fs.readFileSync(
    path.join(root, "lib/caddyRosterImportV1Safe.ts"),
    "utf8"
  );
  const v2ApplySrc = fs.readFileSync(
    path.join(root, "lib/caddyRosterImportV2.ts"),
    "utf8"
  );
  const applyRouteSrc = fs.readFileSync(
    path.join(root, "src/app/api/caddies/import/apply/route.ts"),
    "utf8"
  );
  const pageSrc = fs.readFileSync(
    path.join(root, "src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  assert(
    !v1Src.includes("prisma.caddy.delete") &&
      !v1Src.includes("applyImportPayload(") &&
      v1Src.includes("applyRosterImportPayloadV2") &&
      v1Src.includes("buildImportPreview") &&
      !v1Src.includes("teamOrder: r.rowNumber") &&
      !v1Src.includes("teamOrder: i +"),
    "v1-safe reuses v1 match + v2 apply; no caddy.delete; file order is not teamOrder"
  );
  assert(
    v1Src.includes("파일 순서") || v1Src.includes("teamOrder 변환 없음"),
    "v1-safe documents that file order is not teamOrder"
  );
  assert(
    applyRouteSrc.includes('format === "xlsx-v1"') &&
      applyRouteSrc.includes("importPeople") &&
      applyRouteSrc.includes("resolutions") &&
      applyRouteSrc.includes("applyXlsxV1SafePayload") &&
      !applyRouteSrc.includes("allowExplicitNeedsReviewCreates"),
    "apply route v1 payload is importPeople/resolutions; v2 path does not pass review-create flag"
  );
  assert(
    v2ApplySrc.includes("allowExplicitNeedsReviewCreates?: boolean") &&
      v2ApplySrc.includes("!options?.allowExplicitNeedsReviewCreates"),
    "v2 apply still rejects needsReview creates unless v1-safe sets the explicit flag"
  );
  assert(
    pageSrc.includes("자동 반영 가능") &&
      pageSrc.includes("관리자 확인 필요") &&
      pageSrc.includes("Apply 차단 사유") &&
      pageSrc.includes("빈 슬롯 선택") &&
      pageSrc.includes("정말 신규인 경우 신규로 등록") &&
      pageSrc.includes('format: \'xlsx-v1\'') &&
      pageSrc.includes("importPeople: importPreview.importPeople") &&
      pageSrc.includes("if (!isRosterImportV2ApplyFormat(importPreview.format)) return;"),
    "UI has v1-safe counts/slot select and keeps v2 applyPayload path gated"
  );
  assert(
    pageSrc.includes("applyPayload: importPreview.applyPayload") &&
      pageSrc.includes("CSV v2") &&
      pageSrc.includes("XLSX v2"),
    "CSV v2 / XLSX v2 applyPayload path remains"
  );

  const fakeKeepOrder: V1SafeResolution[] = [
    { name: "이영진", teamOrder: 1 },
  ];
  const previewAfterFake = buildXlsxV1SafePreview(
    rows([{ name: "이영진", team: "1조" }]),
    existing
  );
  assert(
    previewAfterFake.rows.find((r) => r.name === "이영진")?.currentTeamOrder === 7,
    "preview teamOrder comes from DB, not resolution/file"
  );
  void fakeKeepOrder;

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
