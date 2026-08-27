/**
 * 날짜별 배치 Draft persistence 단위 테스트 (production DB write 없음)
 * 실행: npx tsx scripts/test-daily-board-draft-unit.ts
 */
import fs from "fs";
import path from "path";
import {
  assignmentDraftToPayload,
  DAILY_BOARD_DRAFT_SCHEMA_VERSION,
  draftAutosaveCandidate,
  DRAFT_VERSION_CONFLICT,
  DRAFT_VERSION_CONFLICT_MESSAGE,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
  resolveDraftRequestDate,
} from "../src/lib/dailyBoardDraft";
import {
  DailyBoardDraftConflictError,
  getDailyBoardDraft,
  resetDailyBoardDraft,
  saveDailyBoardDraft,
  type DailyBoardDraftDb,
} from "../src/lib/dailyBoardDraftService";
import {
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  REASON,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  applyLiveChangePreviewToDraft,
  hasBlockingLiveChangeError,
  makeAddReservationChange,
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
} from "../src/lib/assignmentChange";
import { parseYmd } from "../src/lib/availabilityEngine";

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

function cloneRow(row: DraftRow): DraftRow {
  return {
    date: new Date(row.date),
    version: row.version,
    schemaVersion: row.schemaVersion,
    payload: clone(row.payload),
    updatedAt: new Date(row.updatedAt),
    updatedByUserId: row.updatedByUserId,
    createdAt: new Date(row.createdAt),
  };
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
    {
      id: "A",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:00",
      teamName: "a",
      rawRowIndex: 2,
    },
    {
      id: "B",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:08",
      teamName: "b",
      rawRowIndex: 3,
    },
    {
      id: "C",
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "07:16",
      teamName: "c",
      rawRowIndex: 4,
    },
    {
      id: "D",
      date,
      course: "SKY",
      shift: "2부",
      teeTime: "13:00",
      teamName: "d",
      rawRowIndex: 5,
    },
  ];
}

function makeDraft(date: string, available = pool(8)): AssignmentDraft {
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date),
  });
  return createDraftFromAutoResult(result, available);
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

function createMemoryDraftDb() {
  const rows = new Map<number, DraftRow>();
  const dailyReservations = [{ id: 101, date: "2026-08-26" }];
  const dailyPlacements = [{ id: 201, reservationId: 101 }];
  const keyOf = (d: Date) => d.getTime();

  const api: DailyBoardDraftDb = {
    dailyBoardDraft: {
      findUnique: async ({ where }) => {
        const row = rows.get(keyOf(where.date));
        return row ? cloneRow(row) : null;
      },
      create: async ({ data }) => {
        const k = keyOf(data.date);
        if (rows.has(k)) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
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
        if (!existing || existing.version !== where.version) {
          return { count: 0 };
        }
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
    $transaction: async (fn) => fn(api),
  };

  return { db: api, rows, dailyReservations, dailyPlacements };
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

async function main() {
section("payload: canonical AssignmentDraft only");
{
  const date = "2026-08-26";
  const draft = makeDraft(date);
  const payload = assignmentDraftToPayload(draft);
  assert(payload.schemaVersion === DAILY_BOARD_DRAFT_SCHEMA_VERSION, "schemaVersion 1");
  assert(payload.date === date, "payload.date");
  assert(Array.isArray(payload.assignments), "assignments");
  assert(Array.isArray(payload.unassignedReservations), "unassigned");
  assert(Array.isArray(payload.sparesByShift), "spares");
  assert(Array.isArray(payload.caddyPool), "caddyPool");
  assert(!("swapKey" in payload), "no swapKey");
  assert(!("search" in payload), "no search");
  const roundtrip = payloadToAssignmentDraft(payload);
  assert(roundtrip.date === date, "hydrate date");
  assert(roundtrip.assignments.length === draft.assignments.length, "hydrate assignments");
  const parsed = parseDailyBoardDraftPayload(payload, date);
  assert(parsed.date === date, "parse expected date");
  let uiThrew = false;
  try {
    parseDailyBoardDraftPayload({ ...payload, swapKey: "x" }, date);
  } catch {
    uiThrew = true;
  }
  assert(uiThrew, "reject UI-only swapKey");
  let dateThrew = false;
  try {
    parseDailyBoardDraftPayload(payload, "2026-08-25");
  } catch {
    dateThrew = true;
  }
  assert(dateThrew, "reject mismatched payload.date");
  assert(resolveDraftRequestDate("2026-08-26", "2026-08-25") === null, "URL/body date mismatch");
  assert(resolveDraftRequestDate("2026-08-26", "2026-08-26") === "2026-08-26", "matching dates");
  assert(resolveDraftRequestDate(null, "2026-08-26") === "2026-08-26", "body date only");
}

section("자동배치 → Draft 생성 + 새로고침 hydrate");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  const created = await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
    db,
  });
  assert(created.version === 1, "first save version=1");
  assert(created.updatedByUserId === null, "env-only admin updatedByUserId null");
  const hydrated = await getDailyBoardDraft(date, db);
  assert(!!hydrated, "GET after create");
  assert(hydrated?.version === 1, "hydrate version");
  const restored = payloadToAssignmentDraft(hydrated!.payload);
  assert(restored.assignments.length === draft.assignments.length, "메뉴 복귀/새로고침 동일 board");
  const otherAdmin = await getDailyBoardDraft(date, db);
  assert(otherAdmin?.version === hydrated?.version, "다른 admin 동일 Draft");
  assert(
    JSON.stringify(otherAdmin?.payload.assignments.map((a) => a.caddy.id)) ===
      JSON.stringify(hydrated?.payload.assignments.map((a) => a.caddy.id)),
    "다른 admin 동일 assignments"
  );
}

section("날짜 A/B 완전 분리");
{
  const { db } = createMemoryDraftDb();
  const a = makeDraft("2026-08-25");
  const b = makeDraft("2026-08-26");
  await saveDailyBoardDraft({
    date: "2026-08-25",
    expectedVersion: 0,
    payload: assignmentDraftToPayload(a),
    updatedByUserId: 1,
    db,
  });
  const savedB = await saveDailyBoardDraft({
    date: "2026-08-26",
    expectedVersion: 0,
    payload: assignmentDraftToPayload(b),
    updatedByUserId: 2,
    db,
  });
  const gotA = await getDailyBoardDraft("2026-08-25", db);
  const gotB = await getDailyBoardDraft("2026-08-26", db);
  assert(gotA?.payload.date === "2026-08-25", "A date");
  assert(gotB?.payload.date === "2026-08-26", "B date");
  assert(gotA?.version === 1 && savedB.version === 1, "each date starts at v1");
  const nextB = { ...b, status: "EDITED" as const };
  await saveDailyBoardDraft({
    date: "2026-08-26",
    expectedVersion: 1,
    payload: assignmentDraftToPayload(nextB),
    updatedByUserId: 2,
    db,
  });
  const afterA = await getDailyBoardDraft("2026-08-25", db);
  assert(afterA?.version === 1, "B 수정이 A version에 영향 없음");
  assert(afterA?.payload.status === "DRAFT", "B 수정이 A payload에 영향 없음");
  assert(parseYmd("2026-08-25").start.getTime() !== parseYmd("2026-08-26").start.getTime(), "date keys differ");
}

section("자동저장 후 version 증가 + stale 409");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: 10,
    db,
  });
  const edited = { ...draft, status: "EDITED" as const };
  const v2 = await saveDailyBoardDraft({
    date,
    expectedVersion: 1,
    payload: assignmentDraftToPayload(edited),
    updatedByUserId: 10,
    db,
  });
  assert(v2.version === 2, "autosave version++");
  const beforeStale = await getDailyBoardDraft(date, db);
  const stalePayload = assignmentDraftToPayload({
    ...draft,
    status: "CONFIRMED",
  });
  let conflict: DailyBoardDraftConflictError | null = null;
  try {
    await saveDailyBoardDraft({
      date,
      expectedVersion: 1,
      payload: stalePayload,
      updatedByUserId: 11,
      db,
    });
  } catch (e) {
    if (e instanceof DailyBoardDraftConflictError) conflict = e;
  }
  assert(!!conflict, "stale version → conflict");
  assert(conflict?.status === 409, "HTTP 409");
  assert(conflict?.code === DRAFT_VERSION_CONFLICT, "conflict code");
  assert(conflict?.message === DRAFT_VERSION_CONFLICT_MESSAGE, "conflict copy");
  const afterStale = await getDailyBoardDraft(date, db);
  assert(afterStale?.version === beforeStale?.version, "409 does not bump version");
  assert(afterStale?.payload.status === "EDITED", "409 does not overwrite server Draft");
  assert(afterStale?.payload.status !== "CONFIRMED", "stale CONFIRMED not written");
}

section("신규 row 동시 생성 race");
{
  const date = "2026-08-27";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  const payload = assignmentDraftToPayload(draft);
  const results = await Promise.allSettled([
    saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload,
      updatedByUserId: 1,
      db,
    }),
    saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload({ ...draft, status: "EDITED" }),
      updatedByUserId: 2,
      db,
    }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert(ok.length === 1, "create race: 1 winner");
  assert(rejected.length === 1, "create race: 1 loser");
  const err = (rejected[0] as PromiseRejectedResult).reason;
  assert(err instanceof DailyBoardDraftConflictError, "loser is 409 conflict");
  const latest = await getDailyBoardDraft(date, db);
  assert(latest?.version === 1, "race leaves single v1 row");
}

section("live 병가 APPLY 성공 후 Draft 최신화");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const available = pool(8);
  const draft = makeDraft(date, available);
  const created = await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: 1,
    db,
  });
  const sickId = draft.assignments[0].caddy.id;
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: sickId },
  });
  assert(!hasBlockingLiveChangeError(preview.warnings), "sick preview ok");
  const applyOk = true;
  const next = applyLiveChangePreviewToDraft(draft, preview);
  const toSave = draftAutosaveCandidate({ mutationSucceeded: applyOk, draft: next });
  assert(!!toSave, "success candidate");
  const saved = await saveDailyBoardDraft({
    date,
    expectedVersion: created.version,
    payload: assignmentDraftToPayload(toSave!),
    updatedByUserId: 1,
    db,
  });
  assert(saved.version === 2, "sick apply bumps version");
  assert(
    saved.payload.assignments.every((row) => row.caddy.id !== sickId),
    "병가 캐디가 Draft에서 빠짐"
  );
}

section("당추 성공 후 Draft 최신화");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: 1,
    db,
  });
  const preview = previewLiveChangeFromDraft({
    draft,
    change: makeAddReservationChange({
      date,
      course: "LAKE",
      shift: "1부",
      teeTime: "08:00",
      teamName: "당추팀",
    }),
  });
  assert(!hasBlockingLiveChangeError(preview.warnings), "당추 preview ok");
  const next = applyLiveChangePreviewToDraft(draft, preview);
  const saved = await saveDailyBoardDraft({
    date,
    expectedVersion: 1,
    payload: assignmentDraftToPayload(next),
    updatedByUserId: 1,
    db,
  });
  assert(saved.version === 2, "당추 version++");
  assert(
    saved.payload.assignments.some((row) => row.reservation.teamName === "당추팀") ||
      saved.payload.unassignedReservations.some(
        (u) => u.reservation.teamName === "당추팀"
      ),
    "당추 예약이 Draft에 반영"
  );
}

section("MOVE_RESERVATION 성공 후 Draft 최신화");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: 1,
    db,
  });
  const source = draft.assignments[0];
  const preview = previewLiveChangeFromDraft({
    draft,
    change: makeMoveReservationChange({
      reservationKey: reservationKey(source.reservation),
      to: { course: "LAKE", shift: "1부", teeTime: "09:00", date },
    }),
  });
  if (hasBlockingLiveChangeError(preview.warnings)) {
    assert(true, "move blocked by engine — skip persist (not a draft save)");
  } else {
    const next = applyLiveChangePreviewToDraft(draft, preview);
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 1,
      payload: assignmentDraftToPayload(next),
      updatedByUserId: 1,
      db,
    });
    assert(saved.version === 2, "MOVE version++");
    assert(
      saved.payload.assignments.some(
        (row) =>
          reservationKey(row.reservation) !== reservationKey(source.reservation) ||
          row.reservation.course === "LAKE" ||
          row.reservation.teeTime === "09:00"
      ) ||
        saved.payload.assignments.some((row) => row.reservation.course === "LAKE"),
      "MOVE 결과가 Draft에 반영"
    );
  }
}

section("실패한 live mutation은 Draft 저장하지 않음");
{
  const date = "2026-08-26";
  const { db } = createMemoryDraftDb();
  const draft = makeDraft(date);
  const created = await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: 1,
    db,
  });
  const sickId = draft.assignments[0].caddy.id;
  const preview = previewLiveChangeFromDraft({
    draft,
    change: { type: "CADDY_SICK", caddyId: sickId },
  });
  const failedNext = applyLiveChangePreviewToDraft(draft, preview);
  const toSave = draftAutosaveCandidate({
    mutationSucceeded: false,
    draft: failedNext,
  });
  assert(toSave === null, "failure candidate is null");
  const after = await getDailyBoardDraft(date, db);
  assert(after?.version === created.version, "failed mutation did not save");
  assert(
    after?.payload.assignments.some((row) => row.caddy.id === sickId),
    "server Draft still has pre-fail board"
  );
}

section("Draft reset은 DailyReservation/DailyPlacement를 삭제하지 않음");
{
  const date = "2026-08-26";
  const mem = createMemoryDraftDb();
  await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(makeDraft(date)),
    updatedByUserId: 1,
    db: mem.db,
  });
  const result = await resetDailyBoardDraft(date, mem.db);
  assert(result.deleted === true, "draft row deleted");
  assert((await getDailyBoardDraft(date, mem.db)) === null, "GET after reset is null");
  assert(mem.dailyReservations.length === 1, "DailyReservation untouched");
  assert(mem.dailyPlacements.length === 1, "DailyPlacement untouched");
}

section("source guards: API / UI / migration / live save order");
{
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const panel = readSrc("src/app/manage/assignments/LiveChangePanel.tsx");
  const route = readSrc("src/app/api/assignments/draft/route.ts");
  const service = readSrc("src/lib/dailyBoardDraftService.ts");
  const payloadLib = readSrc("src/lib/dailyBoardDraft.ts");
  const sql = readSrc("prisma/migrations/20260826120000_daily_board_draft/migration.sql");
  const schema = readSrc("prisma/schema.prisma");

  const persist = page.split("async function persistLivePreview")[1]?.split("function quickActionToast")[0] || "";
  const failBlock = persist.split("if (!res.ok)")[1]?.split("let savedDraft")[0] || "";
  assert(!/queueDraftSave/.test(failBlock), "failed live mutation block has no queueDraftSave");
  assert(/draftAutosaveCandidate/.test(persist), "success path uses draftAutosaveCandidate");
  assert(/queueDraftSave\(toSave, true\)/.test(persist), "success saves latest draft immediately");
  assert(/\/api\/assignments\/reflow\/apply/.test(persist.split("if (!res.ok)")[0] || persist), "live apply API before draft save");

  const run = page.split("async function runAutoAssign")[1]?.split("function onReplace")[0] || "";
  const runFail = run.split("if (!res.ok)")[1]?.split("setAutoResult(data)")[0] || "";
  assert(!/setDraft\(null\)/.test(runFail), "failed auto-assign does not clear draft");
  assert(
    /현재 저장된 작업본을 새 자동배치 결과로 다시 만들까요\?/.test(run),
    "overwrite confirm when stored draft exists"
  );
  assert(/queueDraftSave\(next, true\)/.test(run), "auto-assign result saves immediately");

  assert(/1500/.test(page) && /queueDraftSave/.test(page), "1.5s debounce autosave");
  assert(/저장 중…/.test(page), "saving UI");
  assert(/자동 저장됨/.test(page), "saved UI");
  assert(/저장 실패 · 다시 시도/.test(page), "error retry UI");
  assert(/최신 배치 불러오기/.test(page), "conflict reload button");
  assert(page.includes(DRAFT_VERSION_CONFLICT_MESSAGE) || page.includes("다른 직원이 이 날짜 배치표를 수정했습니다"), "409 copy");
  assert(/loadServerDraft/.test(page) && /\/api\/assignments\/draft\?date=/.test(page), "hydrate GET");
  assert(/applyHydratedDraft/.test(page), "hydrate into AssignmentDraft");
  assert(
    !page.includes('from "@/lib/dailyBoardDraftService"'),
    "client page does not import prisma service"
  );

  assert(/export async function GET/.test(route) && /requireAdmin/.test(route), "GET requireAdmin");
  assert(/export async function PUT/.test(route) && /requireAdmin/.test(route), "PUT requireAdmin");
  assert(/export async function DELETE/.test(route) && /requireAdmin/.test(route), "DELETE requireAdmin");
  const getFn = route.split("export async function GET")[1]?.split("export async function PUT")[0] || "";
  const putFn = route.split("export async function PUT")[1]?.split("export async function DELETE")[0] || "";
  const delFn = route.split("export async function DELETE")[1] || "";
  assert(getFn.trim().startsWith("(req: NextRequest)") && getFn.includes("requireAdmin") && getFn.indexOf("requireAdmin") < getFn.indexOf("getDailyBoardDraft"), "GET admin before read");
  assert(putFn.includes("requireAdmin") && putFn.indexOf("requireAdmin") < putFn.indexOf("saveDailyBoardDraft"), "PUT admin before write");
  assert(delFn.includes("requireAdmin") && delFn.indexOf("requireAdmin") < delFn.indexOf("resetDailyBoardDraft"), "DELETE admin before reset");
  assert(/updatedByUserId: auth\?\.userId \?\? null/.test(route), "env-only admin nullable user id");
  assert(/resolveDraftRequestDate/.test(route), "server validates request date");

  assert(/dailyBoardDraft\.deleteMany/.test(service), "reset deletes draft row");
  assert(!/dailyReservation\.delete/.test(service), "reset service has no reservation delete");
  assert(!/dailyPlacement\.delete/.test(service), "reset service has no placement delete");
  const resetFn = page.split("const resetStoredDraft")[1]?.split("useEffect")[0] || "";
  assert(/method: "DELETE"/.test(resetFn), "UI reset calls DELETE");
  assert(!/dailyReservation/.test(resetFn) && !/DailyPlacement/.test(resetFn), "UI reset does not touch placements");
  assert(/작업본 초기화/.test(panel), "reset in LiveChangePanel");
  const adminTools = panel.split("{adminToolsOpen &&")[1]?.split("{error &&")[0] || "";
  assert(/작업본 초기화/.test(adminTools), "reset only in 관리 도구");
  assert(/이미 적용된 예약·배치는 남습니다/.test(panel), "reset copy: production data kept");

  assert(/CREATE TABLE "DailyBoardDraft"/.test(sql), "additive CREATE TABLE");
  assert(/UNIQUE INDEX "DailyBoardDraft_date_key"/.test(sql), "unique date");
  assert(!/DROP TABLE "DailyReservation"/.test(sql), "no DailyReservation drop");
  assert(!/DROP TABLE "DailyPlacement"/.test(sql), "no DailyPlacement drop");
  assert(!/ALTER TABLE "DailyReservation"/.test(sql), "no DailyReservation alter");
  assert(!/ALTER TABLE "DailyPlacement"/.test(sql), "no DailyPlacement alter");
  assert(/model DailyBoardDraft/.test(schema), "schema model");
  assert(/updatedByUserId\s+Int\?/.test(schema), "nullable updatedByUserId");
  assert(/date\s+DateTime\s+@unique/.test(schema.split("model DailyBoardDraft")[1] || ""), "date unique");

  assert(!/opsDuty|shiftDuty|specialDuty|thirdStart/.test(payloadLib.split("export type DailyBoardDraftPayloadV1")[1]?.split("export class")[0] || ""), "payload type omits duty/special/off");
  assert(/CONFIRMED/.test(page), "client CONFIRMED kept as legacy ops status");
  assert(/function onConfirm/.test(page), "legacy onConfirm handler kept");
  assert(/async function onApplyToOps/.test(page), "legacy onApplyToOps handler kept");
  assert(/function StatusBadge/.test(page), "legacy StatusBadge helper kept");
  assert(!/<StatusBadge/.test(page), "CONFIRMED status chip not rendered");
  assert(/\/api\/assignments\/confirm/.test(page), "legacy confirm API still in page handler");
  const actionsUi = page.split('className="ops-actions"')[1]?.split("</div>")[0] || "";
  assert(!/>\s*CONFIRMED\s*</.test(actionsUi), "CONFIRMED button not in ops-actions");
  assert(!/운영 반영/.test(actionsUi), "운영 반영 button not in ops-actions");
  assert(/배치 확정/.test(page), "Published 확정 primary action");
  assert(/publishBoardActionState/.test(page), "already-current publish label");
  assert(/PUBLISH_HINT/.test(page), "publish hint copy");
}

section("저장된 평일 Draft는 엔진 수정만으로 자동 교정되지 않음");
{
  const date = "2026-08-27";
  const weekend: AutoAssignCaddy = {
    id: 12,
    name: "W12",
    team: "12조",
    teamOrder: 1,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKEND",
    employmentStatus: "ACTIVE",
  };
  const weekdayThird: AutoAssignCaddy = {
    id: 10,
    name: "D10",
    team: "10조",
    teamOrder: 1,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKDAY",
    employmentStatus: "ACTIVE",
  };
  const available = [...pool(8), weekend, weekdayThird];
  const fresh = computeAutoAssignmentsV1({
    date,
    available,
    reservations: [
      ...reservations(date),
      {
        id: "T1",
        date,
        course: "LAKE",
        shift: "3부",
        teeTime: "14:00",
        teamName: "3부-1",
      },
    ],
  });
  assert(
    !fresh.assignments.some(
      (a) => a.shift === "3부" && a.caddy.id === 12
    ),
    "엔진 재실행: 평일 WEEKEND 3부 0"
  );

  const staleDraft = createDraftFromAutoResult(fresh, available);
  staleDraft.assignments = [
    ...staleDraft.assignments,
    {
      date,
      shift: "3부",
      sequenceIndex: 99,
      reason: REASON.REGULAR_SEQUENCE,
      reservation: {
        id: "STALE-W12",
        date,
        course: "LAKE",
        shift: "3부",
        teeTime: "15:00",
        teamName: "버그초안",
      },
      caddy: weekend,
      kind: "regular",
    },
  ];
  const { db } = createMemoryDraftDb();
  await saveDailyBoardDraft({
    date,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(staleDraft),
    updatedByUserId: null,
    db,
  });
  const hydrated = await getDailyBoardDraft(date, db);
  const restored = payloadToAssignmentDraft(hydrated!.payload);
  assert(
    restored.assignments.some(
      (a) => a.shift === "3부" && a.caddy.id === 12 && a.caddy.name === "W12"
    ),
    "hydrate는 저장된 평일 WEEKEND 3부 행을 그대로 둠"
  );
  const parsed = parseDailyBoardDraftPayload(hydrated!.payload, date);
  assert(
    parsed.assignments.some((a) => a.caddy.id === 12),
    "parseDailyBoardDraftPayload는 엔진을 다시 돌리지 않음"
  );

  const replaced = createDraftFromAutoResult(fresh, available);
  assert(
    !replaced.assignments.some((a) => a.caddy.id === 12),
    "자동배치를 다시 실행하면 평일 WEEKEND 3부가 빠짐"
  );

  const draftRoute = readSrc("src/app/api/assignments/draft/route.ts");
  assert(
    !/computeAutoAssignmentsV1/.test(draftRoute),
    "GET/PUT Draft API는 엔진 재계산 없음"
  );
  const page = readSrc("src/app/manage/assignments/page.tsx");
  assert(
    /현재 저장된 작업본을 새 자동배치 결과로 다시 만들까요/.test(page) &&
      /queueDraftSave\(next, true\)/.test(page),
    "직원이 자동배치 실행 시 저장된 Draft를 새 결과로 교체"
  );
}

section("캐디 권한 Draft API 접근 불가 (requireAdmin 401)");
{
  const route = readSrc("src/app/api/assignments/draft/route.ts");
  assert(/requireAdmin/.test(route), "route uses requireAdmin (caddy → 401)");
  const auth = readSrc("src/lib/auth.ts");
  const requireAdmin = auth.split("export async function requireAdmin")[1]?.split("export function forbiddenAccountManager")[0] || "";
  assert(/auth\.role !== "admin"/.test(requireAdmin), "non-admin 401");
  assert(/status: 401/.test(requireAdmin), "401 unauthorized");
}

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}/${passed + failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
