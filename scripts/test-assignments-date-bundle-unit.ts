/**
 * Assignments date-bundle (Performance PR B)
 * DB/Sheet 없이 가드·배선만 검증.
 *   npm run test:assignments-date-bundle-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  dateBundleSectionWarnings,
  shouldApplyAssignmentsDateBundle,
} from "../src/lib/assignmentsDateBundleView";
import {
  loadAssignmentsDateBundle,
  publishedMetadataFromRecord,
  type AssignmentsDateReadContext,
  type AssignmentsDateReadQueryCounts,
} from "../src/lib/assignmentsDateBundle";
import { mapUnavailablePanelRows } from "../src/lib/dailyBoardDraftService";
import type { DailyBoardPublishedRecord } from "../src/lib/dailyBoardPublishedService";
import type { AvailabilityWithSlotGrid } from "../src/lib/availabilityService";
import type { BoardPushPreview } from "../src/lib/boardPush";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("date race / loadGen");
{
  assert(
    shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-02",
      selectedDate: "2026-10-02",
    }),
    "current gen + matching date applies"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 1,
      latestGen: 2,
      payloadDate: "2026-10-01",
      selectedDate: "2026-10-02",
    }),
    "stale gen ignored even if caller forgets date"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-01",
      selectedDate: "2026-10-02",
    }),
    "late 10/1 payload cannot overwrite 10/2"
  );
  assert(
    !shouldApplyAssignmentsDateBundle({
      requestGen: 2,
      latestGen: 2,
      payloadDate: "2026-10-02",
      selectedDate: "2026-10-02",
      cancelled: true,
    }),
    "cancelled effect ignored"
  );
}

section("optional section warnings");
{
  const lines = dateBundleSectionWarnings({
    draft: { error: "작업본 조회 실패" },
    boardPreview: { error: "미리보기 실패" },
    specialDuties: { error: "특수근무 처리 실패" },
  });
  assert(!lines.some((line) => line.includes("작업본")), "draft error is critical, not a warning line");
  assert(lines.some((line) => line.includes("배치표 알림")), "preview warning labeled");
  assert(lines.some((line) => line.includes("특수근무")), "special duty warning labeled");
}

section("unavailable panel mapper matches existing GET filter");
{
  const rows = mapUnavailablePanelRows([
    {
      caddyId: 11,
      reason: "병가",
      caddy: { name: "재직", team: "A", employmentStatus: "ACTIVE" },
    },
    {
      caddyId: 12,
      reason: "병가",
      caddy: { name: "퇴사", team: "A", employmentStatus: "RETIRED" },
    },
    {
      caddyId: 13,
      reason: "결근",
      caddy: { name: "휴직", team: "B", employmentStatus: "LEAVE" },
    },
    {
      caddyId: 14,
      reason: "병가",
      caddy: { name: "삭제", team: "C", employmentStatus: "DELETED" },
    },
    {
      caddyId: 0,
      reason: "invalid",
      caddy: { name: "없음", team: "A", employmentStatus: "ACTIVE" },
    },
  ]);
  assert(
    rows.map((row) => row.caddyId).join(",") === "11,13",
    "keeps ACTIVE/LEAVE, drops RETIRED/DELETED/invalid"
  );
  assert(rows[0]?.name === "재직" && rows[0]?.reason === "병가", "preserves name/reason");
  assert(rows[1]?.employmentStatus === "LEAVE", "LEAVE stays operational");
}

section("published metadata only");
{
  const meta = publishedMetadataFromRecord({
    date: "2026-10-01",
    schemaVersion: 1,
    sourceDraftVersion: 4,
    payload: {
      schemaVersion: 1,
      date: "2026-10-01",
      openCourses: [],
      placements: [],
      sparesByShift: [],
      publisherUsername: "admin1",
    },
    publishedAt: "2026-10-01T00:00:00.000Z",
    publishedByUserId: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as DailyBoardPublishedRecord);
  assert(meta?.sourceDraftVersion === 4, "keeps sourceDraftVersion");
  assert(meta?.publishedByUsername === "admin1", "keeps publisher username");
  assert(meta && !("payload" in meta), "does not expose published board payload");
  assert(publishedMetadataFromRecord(null) === null, "null published stays null");
}

section("route: in-process aggregate + strongest auth");
{
  const route = read("src/app/api/assignments/date-bundle/route.ts");
  assert(/requireAdmin/.test(route), "bundle uses requireAdmin");
  assert(/loadAssignmentsDateBundle/.test(route), "calls shared service");
  assert(!/fetch\(/.test(route), "route does not HTTP-chain other APIs");
  assert(!/requirePublishedReader/.test(route), "not weaker published-reader auth");
}

section("service: reuse + parallel + partial failure");
{
  const svc = read("src/lib/assignmentsDateBundle.ts");
  assert(/createAssignmentsDateReadContext/.test(svc), "request-scoped context");
  assert(/listCaddies/.test(svc) && /listOffOverrides/.test(svc), "shares caddies/overrides");
  assert(/listUnavailablePanelRows/.test(svc), "shares unavailables");
  assert(/Promise\.all/.test(svc), "independent reads in parallel");
  assert(/errors\.availability/.test(svc), "availability is section-level");
  assert(/errors\.boardPreview/.test(svc), "preview is section-level");
  assert(/throw draftResult\.error/.test(svc), "draft failure is critical");
  assert(!/fetch\(`\/api\//.test(svc), "service does not HTTP-chain routes");
  assert(
    /preview(?:Board)?Push\(prisma, ymd, \{/.test(svc),
    "preview reuses published/draft"
  );
  assert(
    /mapUnavailablePanelRows/.test(svc) &&
      /from \"@\/lib\/dailyBoardDraftService\"/.test(svc),
    "bundle reuses existing unavailable panel mapper"
  );
  assert(
    !/function mapUnavailablePanelRows/.test(svc),
    "bundle does not keep a drifted unavailable mapper"
  );
  assert(
    /queryCounts\.caddyFindMany \+= 1/.test(svc) &&
      /if \(!caddiesP\)/.test(svc),
    "caddy findMany is request-scoped once"
  );
  assert(
    /queryCounts\.dailyCaddyUnavailable \+= 1/.test(svc) &&
      /if \(!unavailRawP\)/.test(svc),
    "unavailable query is request-scoped once"
  );
  assert(/OFF_SHEET_CACHE_MS/.test(read("src/lib/offSheetFetch.ts")), "OFF 45s cache kept");
  assert(/OPS_DUTY_SHEET_CACHE_MS/.test(read("src/lib/opsDutySheetFetch.ts")), "ops 45s cache kept");
}

section("availability preload hooks stay optional");
{
  const avail = read("src/lib/availabilityService.ts");
  assert(/listCaddies\?:/.test(avail), "optional caddies reuse");
  assert(/listOffOverrides\?:/.test(avail), "optional override reuse");
  assert(/listUnavailables\?:/.test(avail), "optional unavailable reuse");
  assert(/fetchPublishedOffSheets/.test(avail), "OFF sheet path unchanged");
}

section("client date load is one bundle GET");
{
  const page = read("src/app/manage/assignments/page.tsx");
  assert(/\/api\/assignments\/date-bundle/.test(page), "page fetches date-bundle");
  assert(/shouldApplyAssignmentsDateBundle/.test(page), "date/loadGen guard");
  assert(/loadGen/.test(page), "assignments loadGen");
  assert(
    !/fetch\(`\/api\/availability\?date=/.test(page.split("async function refreshOpsDutyPanel")[0] || ""),
    "date-change path has no availability GET"
  );
  const dateEffect = page.slice(
    page.indexOf("const gen = ++loadGen.current"),
    page.indexOf("useEffect(() => {\n    const onPopState")
  );
  assert(/date-bundle/.test(dateEffect), "date effect uses bundle");
  assert(!/\/api\/availability\?/.test(dateEffect), "date effect has no availability GET");
  assert(!/\/api\/daily-ops-duties\?/.test(dateEffect), "date effect has no ops GET");
  assert(!/\/api\/daily-off-overrides\?/.test(dateEffect), "date effect has no override GET");
  assert(!/\/api\/daily-unavailables\?/.test(dateEffect), "date effect has no unavailable GET");
  assert(!/\/api\/third-weekly-start\?/.test(dateEffect), "date effect has no third-weekly GET");
  assert(!/\/api\/assignments\/published\?/.test(dateEffect), "date effect has no published GET");
  assert(!/off-sheet\/prewarm/.test(dateEffect), "date effect has no delayed prewarm GET");
  assert(/\/api\/assignments\/draft/.test(page), "draft mutation/reload endpoint kept");
  assert(/\/api\/assignments\/published/.test(page), "publish POST kept");
  assert(/clientResourceCache/.test(page) === false, "no assignments SWR cache");
}

section("child panels consume bundle on date load");
{
  const duty = read("src/app/manage/assignments/SpecialDutyPanel.tsx");
  const support = read("src/app/manage/assignments/SpecialSupportPanel.tsx");
  const push = read("src/components/manage/BoardPushNotifyCard.tsx");
  assert(/bundleReady/.test(duty) && /initialPayload/.test(duty), "special duty accepts bundle");
  assert(/bundleReady/.test(support) && /initialPayload/.test(support), "special support accepts bundle");
  assert(/bundleReady/.test(push) && /initialPreview/.test(push), "push card accepts bundle");
  assert(/\/api\/daily-special-duties/.test(duty), "special duty mutation reload kept");
  assert(/\/api\/daily-special-supports/.test(support), "special support mutation kept");
  assert(/\/api\/push\/board-preview/.test(push), "push refresh after send kept");
}

async function runAsyncCases() {
section("golden comparison: bundle sections match legacy endpoint shapes");
{
  const ymd = "2026-10-01";
  const queryCounts: AssignmentsDateReadQueryCounts = {
    caddyFindMany: 0,
    dailyCaddyUnavailable: 0,
    dailyOffOverride: 0,
    dailyOpsDuty: 0,
    dailyOpsDutyOverride: 0,
    dailyBoardDraft: 0,
    dailyBoardPublished: 0,
  };
  let caddyCalls = 0;
  let unavailCalls = 0;
  let offCalls = 0;
  let opsDutyCalls = 0;
  let opsOverrideCalls = 0;
  let draftCalls = 0;
  let publishedCalls = 0;
  const caddies = [
    {
      id: 11,
      name: "재직",
      team: "A",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      caddyType: "REGULAR",
      extraFlags: [] as string[],
      thirdBandSubgroup: null,
    },
    {
      id: 12,
      name: "퇴사",
      team: "A",
      teamOrder: 2,
      employmentStatus: "RETIRED",
      caddyType: "REGULAR",
      extraFlags: [] as string[],
      thirdBandSubgroup: null,
    },
  ];
  const unavailRows = mapUnavailablePanelRows([
    {
      caddyId: 11,
      reason: "병가",
      caddy: { name: "재직", team: "A", employmentStatus: "ACTIVE" },
    },
    {
      caddyId: 12,
      reason: "병가",
      caddy: { name: "퇴사", team: "A", employmentStatus: "RETIRED" },
    },
  ]);
  const fromShift = [
    { caddyId: 11, effectiveFromShift: "2부" as const },
    { caddyId: 12, effectiveFromShift: null },
  ];
  const draftRecord = {
    date: ymd,
    schemaVersion: 1,
    version: 3,
    payload: { schemaVersion: 1, date: ymd, openCourses: [], placements: [] },
    updatedAt: "2026-10-01T00:00:00.000Z",
    updatedByUserId: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const publishedRecord = {
    date: ymd,
    schemaVersion: 1,
    sourceDraftVersion: 3,
    payload: {
      schemaVersion: 1,
      date: ymd,
      openCourses: [],
      placements: [],
      sparesByShift: [],
      publisherUsername: "admin1",
    },
    publishedAt: "2026-10-01T01:00:00.000Z",
    publishedByUserId: 1,
    createdAt: "2026-10-01T01:00:00.000Z",
    updatedAt: "2026-10-01T01:00:00.000Z",
  } as DailyBoardPublishedRecord;
  const offOverrides = [
    { id: 1, caddyId: 11, action: "FORCE_ON", name: "재직", team: "A", employmentStatus: "ACTIVE" },
  ];
  const availability = {
    date: ymd,
    slotGrid: {},
    offOverlay: { baseOffCaddyIds: [99] },
  } as unknown as AvailabilityWithSlotGrid;
  const thirdWeekly = {
    date: ymd,
    weekStart: "2026-09-28",
    autoStartTeam: "A",
    startTeam: "A",
    overridden: false,
  };
  const specialDuties = { date: ymd, groups: [], anchors: {}, placement: null };
  const specialSupports = {
    date: ymd,
    items: [],
    byShift: {},
    byKindPattern: {},
    countsByKind: {},
    candidates: [],
    counts: { "1부": 0, "2부": 0, "3부": 0 },
  };
  const boardPreview = {
    date: ymd,
    published: true,
    freshness: { canSend: true },
    canSend: true,
    sourceDraftVersion: 3,
    currentDraftVersion: 3,
    alreadySent: false,
    counts: { total: 0 },
  } as unknown as BoardPushPreview;

  function memo<T>(countKey: keyof AssignmentsDateReadQueryCounts, bump: () => void, load: () => Promise<T>) {
    let pending: Promise<T> | null = null;
    return () => {
      if (!pending) {
        queryCounts[countKey] += 1;
        bump();
        pending = load();
      }
      return pending;
    };
  }
  const ctx: AssignmentsDateReadContext = {
    date: ymd,
    queryCounts,
    listCaddies: memo("caddyFindMany", () => {
      caddyCalls += 1;
    }, async () => caddies),
    listOffOverrides: memo("dailyOffOverride", () => {
      offCalls += 1;
    }, async () => offOverrides as never),
    listUnavailablePanelRows: memo("dailyCaddyUnavailable", () => {
      unavailCalls += 1;
    }, async () => unavailRows),
    listUnavailableFromShift: async () => fromShift,
    listOpsDuties: memo("dailyOpsDuty", () => {
      opsDutyCalls += 1;
    }, async () => []),
    listOpsDutyOverrides: memo("dailyOpsDutyOverride", () => {
      opsOverrideCalls += 1;
    }, async () => []),
    getDraft: memo("dailyBoardDraft", () => {
      draftCalls += 1;
    }, async () => draftRecord as never),
    getPublished: memo("dailyBoardPublished", () => {
      publishedCalls += 1;
    }, async () => publishedRecord),
  };

  const bundle = await loadAssignmentsDateBundle(ymd, ctx, {
    loadAvailability: async (_ymd, options) => {
      await Promise.all([
        options?.listCaddies?.(),
        options?.listOffOverrides?.(ymd),
        options?.listUnavailables?.(ymd),
        options?.opsDutyDeps?.listDuties?.(ymd),
        options?.opsDutyDeps?.listOverrides?.(ymd),
        options?.opsDutyDeps?.listCaddies?.(),
      ]);
      return availability;
    },
    resolveOpsDuty: async (_ymd, deps) => {
      await deps?.listDuties?.(ymd);
      return {
        source: "none" as const,
        stored: [],
        sheetEntries: [],
        error: null,
      };
    },
    resolveThirdWeekly: async () => thirdWeekly,
    buildSpecialDuties: async () => specialDuties as never,
    buildSpecialSupports: async () => specialSupports as never,
    previewPush: async (_db, date, preload) => {
      assert(date === ymd, "preview receives selected date");
      assert(preload && "published" in preload, "preview reuses published preload");
      assert(
        preload && "currentDraftVersion" in preload && preload.currentDraftVersion === 3,
        "preview reuses draft version"
      );
      return boardPreview;
    },
  });

  const legacyDraft = {
    draft: draftRecord,
    unavailableCaddyIds: fromShift.map((row) => row.caddyId),
    unavailableFromShift: fromShift,
    unavailableRows: unavailRows,
  };
  const legacyUnavailables = { date: ymd, count: unavailRows.length, rows: unavailRows };
  const legacyOff = {
    date: ymd,
    count: offOverrides.length,
    overrides: offOverrides.map((row) => ({
      caddyId: row.caddyId,
      action: row.action,
      name: row.name,
      team: row.team,
    })),
  };
  const legacyPublished = {
    sourceDraftVersion: 3,
    publishedAt: "2026-10-01T01:00:00.000Z",
    publishedByUsername: "admin1",
  };

  assert(bundle.date === ymd, "bundle date matches request");
  assert(
    JSON.stringify(bundle.draft) === JSON.stringify(legacyDraft),
    "draft section matches legacy GET /api/assignments/draft"
  );
  assert(
    JSON.stringify(bundle.unavailables) === JSON.stringify(legacyUnavailables),
    "unavailables section matches GET /api/daily-unavailables"
  );
  assert(
    bundle.unavailables?.rows.every((row) => row.caddyId !== 12),
    "bundle unavailables drop RETIRED like the existing panel GET"
  );
  assert(
    JSON.stringify(bundle.offOverrides) === JSON.stringify(legacyOff),
    "offOverrides section matches GET /api/daily-off-overrides"
  );
  assert(
    JSON.stringify(bundle.published) === JSON.stringify(legacyPublished),
    "published metadata matches assignments page fields"
  );
  assert(bundle.availability === availability, "availability section is the same payload object");
  assert(
    JSON.stringify(bundle.thirdWeeklyStart) === JSON.stringify(thirdWeekly),
    "thirdWeeklyStart matches GET /api/third-weekly-start"
  );
  assert(bundle.specialDuties === specialDuties, "specialDuties matches GET payload");
  assert(bundle.specialSupports === specialSupports, "specialSupports matches GET payload");
  assert(bundle.boardPreview === boardPreview, "boardPreview matches GET /api/push/board-preview");
  assert(bundle.opsDuty?.date === ymd && bundle.opsDuty.count === 0, "opsDuty empty payload keeps date/count");
  assert(Object.keys(bundle.errors).length === 0, "no section errors on full success");
  assert(caddyCalls === 1 && queryCounts.caddyFindMany === 1, "caddies loaded once");
  assert(unavailCalls === 1, "unavailable panel rows loaded once");
  assert(offCalls === 1 && queryCounts.dailyOffOverride === 1, "off overrides loaded once");
  assert(opsDutyCalls === 1 && opsOverrideCalls === 1, "ops duty/override loaded once");
  assert(draftCalls === 1 && publishedCalls === 1, "draft/published loaded once");
}

section("partial failure: optional error does not 500 the board");
{
  const ymd = "2026-10-02";
  const queryCounts: AssignmentsDateReadQueryCounts = {
    caddyFindMany: 0,
    dailyCaddyUnavailable: 0,
    dailyOffOverride: 0,
    dailyOpsDuty: 0,
    dailyOpsDutyOverride: 0,
    dailyBoardDraft: 0,
    dailyBoardPublished: 0,
  };
  const emptyCtx = (): AssignmentsDateReadContext => ({
    date: ymd,
    queryCounts,
    listCaddies: async () => [],
    listOffOverrides: async () => [],
    listUnavailablePanelRows: async () => [],
    listUnavailableFromShift: async () => [],
    listOpsDuties: async () => [],
    listOpsDutyOverrides: async () => [],
    getDraft: async () => null,
    getPublished: async () => null,
  });

  const optionalFail = await loadAssignmentsDateBundle(ymd, emptyCtx(), {
    loadAvailability: async () => {
      throw new Error("가용 계산 실패");
    },
    resolveOpsDuty: async () => ({
      source: "none",
      stored: [],
      sheetEntries: [],
      error: null,
    }),
    resolveThirdWeekly: async () => ({
      date: ymd,
      weekStart: "2026-09-28",
      autoStartTeam: "A",
      startTeam: "A",
      overridden: false,
    }),
    buildSpecialDuties: async () => ({ date: ymd, groups: [] }) as never,
    buildSpecialSupports: async () => ({ date: ymd, items: [] }) as never,
    previewPush: async () => {
      throw new Error("미리보기 실패");
    },
  });
  assert(optionalFail.ok === true, "optional failures still return ok bundle");
  assert(optionalFail.draft !== null, "draft section remains present");
  assert(optionalFail.draft?.draft === null, "empty draft stays null, not wiped by preview");
  assert(optionalFail.availability === null, "failed availability is null");
  assert(optionalFail.boardPreview === null, "failed preview is null");
  assert(optionalFail.errors.availability?.error === "가용 계산 실패", "availability error is surfaced");
  assert(optionalFail.errors.boardPreview?.error === "미리보기 실패", "preview error is surfaced");
  assert(!optionalFail.errors.draft, "draft is not marked optional-failed");
  const warn = dateBundleSectionWarnings(optionalFail.errors);
  assert(warn.some((line) => line.includes("가용")), "UI warning includes availability");
  assert(warn.some((line) => line.includes("배치표 알림")), "UI warning includes preview");

  let draftThrew = false;
  try {
    await loadAssignmentsDateBundle(ymd, {
      ...emptyCtx(),
      getDraft: async () => {
        throw new Error("작업본 조회 실패");
      },
    }, {
      loadAvailability: async () => ({ date: ymd }) as never,
      resolveOpsDuty: async () => ({
        source: "none",
        stored: [],
        sheetEntries: [],
        error: null,
      }),
      resolveThirdWeekly: async () => ({
        date: ymd,
        weekStart: "2026-09-28",
        autoStartTeam: "A",
        startTeam: "A",
        overridden: false,
      }),
      buildSpecialDuties: async () => ({ date: ymd }) as never,
      buildSpecialSupports: async () => ({ date: ymd }) as never,
      previewPush: async () => ({ date: ymd }) as never,
    });
  } catch (e) {
    draftThrew = e instanceof Error && e.message === "작업본 조회 실패";
  }
  assert(draftThrew, "draft failure remains critical and throws");
}
}

section("auth: bundle is not weaker than source GETs");
{
  const auth = read("src/lib/auth.ts");
  const pushAuth = read("src/lib/boardPushAuth.ts");
  const route = read("src/app/api/assignments/date-bundle/route.ts");
  const published = read("src/app/api/assignments/published/route.ts");
  assert(/export async function requireAdmin/.test(auth), "requireAdmin exists");
  assert(/auth.role !== "admin"/.test(auth), "non-admin is unauthorized");
  assert(/status: 401/.test(auth) && /unauthorized/.test(auth), "unauth/non-admin 401");
  assert(/MUST_CHANGE_PASSWORD/.test(auth) && /status: 403/.test(auth), "must-change-password 403");
  assert(/requireAdmin\(req\)/.test(route), "bundle uses requireAdmin");
  assert(/requirePublishedReader/.test(published), "published GET stays reader-wide");
  assert(!/requirePublishedReader/.test(route), "bundle does not use weaker published-reader");
  assert(/requireBoardPushAdmin/.test(pushAuth), "board preview keeps dedicated admin guard");
  assert(/status: 403/.test(pushAuth) && /forbidden/.test(pushAuth), "logged-in non-admin preview is 403");
}

section("existing source endpoints remain");
{
  assert(fs.existsSync(path.resolve("src/app/api/availability/route.ts")), "availability route kept");
  assert(fs.existsSync(path.resolve("src/app/api/assignments/draft/route.ts")), "draft route kept");
  assert(fs.existsSync(path.resolve("src/app/api/daily-ops-duties/route.ts")), "ops route kept");
  assert(fs.existsSync(path.resolve("src/app/api/push/board-preview/route.ts")), "preview route kept");
}

void runAsyncCases()
  .then(() => {
    if (failed > 0) {
      console.error(`\nassignments-date-bundle failed: ${failed} (passed ${passed})`);
      process.exit(1);
    }
    console.log(`\nassignments-date-bundle passed: ${passed}`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
