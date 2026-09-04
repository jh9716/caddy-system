/**
 * 관리자 대시보드 V2 Phase 2 snapshot (엔진/production DB write 없음)
 * 실행: npm run test:daily-ops-snapshot-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildAdminOpsDashboard,
} from "../src/lib/adminOpsDashboard";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { authorizeCronRequest } from "../src/lib/cronAuth";
import {
  dashboardSourceLine,
} from "../src/components/manage/AdminOpsDashboard";
import {
  snapshotHasForbiddenKeys,
  toDailyOpsSnapshotPayload,
  dashboardViewFromSnapshot,
  parseDailyOpsSnapshotPayload,
} from "../src/lib/dailyOpsSnapshot";
import {
  captureDailyOpsSnapshot,
  loadAdminOpsDashboardView,
  type DailyOpsSnapshotDb,
  type DailyOpsSnapshotRow,
} from "../src/lib/dailyOpsSnapshotService";
import type { AdminOpsDashboardSourceDeps } from "../src/lib/adminOpsDashboardSource";
import type { StoredOpsDutyRow } from "../src/lib/dailyOpsDutyService";
import { offNamesForDate, type OffSheet } from "../src/lib/offSheetParser";
import { buildOpsDutySheetTestSheets } from "../src/lib/opsDutySheetParser";
import { formatCapturedAtKst, kstYmd, previousKstYmd } from "../src/lib/kstDate";

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

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const caddies = [
  {
    id: 1,
    name: "이제이",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE" as const,
  },
  {
    id: 2,
    name: "김지윤",
    team: "2조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE" as const,
  },
];

function offSheetForDate(ymd: string, names: string[]): OffSheet {
  const [y, m, d] = ymd.split("-");
  return {
    name: `${m}${d}`,
    matrix: [
      [`${y}.${m}.${d} (월)`, "", ""],
      ["1조", "2조", "3조"],
      [names[0] || "", names[1] || "", names[2] || ""],
    ],
  };
}

function opsSheetsForDate(
  ymd: string,
  names: { duty?: string; marshal?: string; leader?: string } = {}
) {
  return buildOpsDutySheetTestSheets([
    {
      name: "0901~0914",
      startDate: ymd,
      week1Dates: [ymd, "2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06", "2099-01-07"],
      week2Dates: ["2099-01-08", "2099-01-09", "2099-01-10", "2099-01-11", "2099-01-12", "2099-01-13", "2099-01-14"],
      week1Names: [
        {
          당번_조출_1: names.duty ?? "이제이",
          마샬_조출_1: names.marshal ?? "김지윤",
          조장_1: names.leader ?? "이제이",
        },
      ],
    },
  ]);
}

function storedDuty(name: string): StoredOpsDutyRow {
  return {
    id: 1,
    role: "DUTY_AM",
    roleKey: "당번_조출_1",
    caddyId: 1,
    rawName: name,
    name,
    team: "1조",
    employmentStatus: "ACTIVE",
  };
}

function mockLoadAvailability() {
  return async (
    ymd: string,
    options?: {
      includeOffSheet?: boolean;
      offSheets?: OffSheet[];
      dutyEntries?: { kind: string; roleKey: string; rawName: string }[];
    }
  ) => {
    const base = computeAvailability({ date: ymd, caddies, assignments: [] });
    const offNames =
      options?.includeOffSheet && options.offSheets
        ? offNamesForDate(options.offSheets, ymd).names
        : [];
    return applyDailyExternalExclusions({
      availability: base,
      caddies,
      offNames,
      dutyEntries: options?.dutyEntries ?? [],
    });
  };
}

function completeSourceDeps(
  ymd: string,
  extras?: {
    onOffFetch?: () => void;
    onOpsFetch?: () => void;
    onAvail?: () => void;
  }
): AdminOpsDashboardSourceDeps {
  return {
    loadAvailability: async (date, options) => {
      extras?.onAvail?.();
      return mockLoadAvailability()(date, options);
    },
    listDuties: async () => [storedDuty("이제이")],
    fetchOffSheets: async () => {
      extras?.onOffFetch?.();
      return [offSheetForDate(ymd, ["김지윤"])];
    },
    fetchOpsDutySheets: async () => {
      extras?.onOpsFetch?.();
      return [];
    },
  };
}

function liveDashboard(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(`${date}T23:59:59.999`);
  const base = computeAvailability({
    date,
    caddies,
    assignments: [{ caddyId: 2, type: "OFF", startDate: start, endDate: end }],
  });
  const availability = applyDailyExternalExclusions({
    availability: base,
    caddies,
    offNames: [],
    dutyEntries: [{ kind: "duty_am", roleKey: "당번_조출_1", rawName: "이제이" }],
  });
  return buildAdminOpsDashboard({
    date,
    availability,
    opsDuties: [{ role: "DUTY_AM", name: "이제이" }],
  });
}

function memoryDb(seed: DailyOpsSnapshotRow[] = []): DailyOpsSnapshotDb {
  const rows = new Map<number, DailyOpsSnapshotRow>();
  for (const row of seed) rows.set(row.date.getTime(), { ...row, payload: structuredClone(row.payload) });
  return {
    dailyOpsSnapshot: {
      async findUnique({ where }) {
        const found = rows.get(where.date.getTime()) ?? null;
        return found ? { ...found, payload: structuredClone(found.payload) } : null;
      },
      async create({ data }) {
        if (rows.has(data.date.getTime())) {
          throw { code: "P2002" };
        }
        const row: DailyOpsSnapshotRow = {
          date: data.date,
          payload: structuredClone(data.payload),
          schemaVersion: data.schemaVersion,
          capturedAt: data.capturedAt,
        };
        rows.set(data.date.getTime(), row);
        return { ...row, payload: structuredClone(row.payload) };
      },
    },
  };
}

async function main() {
section("snapshot payload = dashboard normalized data");
{
  const dash = liveDashboard("2026-09-03");
  const payload = toDailyOpsSnapshotPayload(dash);
  assert(payload.date === dash.date, "date 일치");
  assert(payload.roster.activeCount === dash.roster.activeCount, "재직 total");
  assert(payload.roster.houseCount === dash.roster.houseCount, "HOUSE total");
  assert(payload.availability.finalAvailable === dash.availability.finalAvailable, "final available");
  assert(payload.availability.offCount === dash.availability.offCount, "off count");
  assert(payload.opsDuties[0]?.names.includes("이제이"), "조출 당번 이름");
  const jay = payload.caddies.find((c) => c.caddyId === 1);
  const kim = payload.caddies.find((c) => c.caddyId === 2);
  assert(jay?.name === "이제이" && jay.team === "1조" && jay.caddyId === 1, "이름/조 보존");
  assert(kim?.name === "김지윤" && kim.team === "2조" && kim.status === "excluded", "비가용 status 보존");
  assert(kim?.reasons.includes("휴무"), "exclusion reason 보존");
}

section("phone/vehicle/customer/reservation 없음");
{
  const dash = liveDashboard("2026-09-03");
  const dirty = {
    ...toDailyOpsSnapshotPayload(dash),
    phone: "010",
  };
  assert(snapshotHasForbiddenKeys(toDailyOpsSnapshotPayload(dash)).length === 0, "정상 payload 개인정보 키 없음");
  assert(snapshotHasForbiddenKeys(dirty).includes("phone"), "금지키 검출");
  const json = JSON.stringify(toDailyOpsSnapshotPayload(dash));
  assert(!/phone|vehicle|reservation|전화번호|차량번호|customer/i.test(json), "JSON에 개인정보 필드 없음");
}

section("complete source → snapshot 생성 / overwrite 금지");
{
  const db = memoryDb();
  let offFetches = 0;
  const created = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    now: new Date("2026-09-04T00:30:00+09:00"),
    sourceDeps: completeSourceDeps("2026-09-03", { onOffFetch: () => { offFetches += 1; } }),
  });
  assert(created.status === "created", "complete source → snapshot 생성");
  assert(offFetches === 1, "생성 시 OFF Sheet를 읽음");

  const saved = await db.dailyOpsSnapshot.findUnique({
    where: { date: new Date("2026-09-03T00:00:00") },
  });
  const firstName = (saved?.payload as { caddies?: { name: string }[] })?.caddies?.[0]?.name;

  let secondFetches = 0;
  const second = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    now: new Date("2026-09-05T00:30:00+09:00"),
    sourceDeps: completeSourceDeps("2026-09-03", { onOffFetch: () => { secondFetches += 1; } }),
  });
  assert(second.status === "exists", "기존 Snapshot overwrite 금지");
  assert(second.capturedAt === created.capturedAt, "capturedAt 유지");
  assert(secondFetches === 0, "이미 있으면 Sheet를 다시 읽지 않음");
  const again = await db.dailyOpsSnapshot.findUnique({
    where: { date: new Date("2026-09-03T00:00:00") },
  });
  assert(
    (again?.payload as { caddies?: { name: string }[] })?.caddies?.[0]?.name === firstName,
    "payload 유지"
  );

  const first = liveDashboard("2026-09-03");
  const raced = memoryDb();
  let finds = 0;
  raced.dailyOpsSnapshot.findUnique = async () => {
    finds += 1;
    if (finds === 1) return null;
    return {
      date: new Date("2026-09-03T00:00:00"),
      payload: toDailyOpsSnapshotPayload(first),
      schemaVersion: 1,
      capturedAt: new Date("2026-09-04T00:30:00+09:00"),
    };
  };
  raced.dailyOpsSnapshot.create = async () => {
    throw { code: "P2002" };
  };
  const dup = await captureDailyOpsSnapshot("2026-09-03", {
    db: raced,
    sourceDeps: completeSourceDeps("2026-09-03"),
  });
  assert(dup.status === "exists", "P2002 race는 exists");
}

section("오늘 live / 과거 snapshot / 과거 없음");
{
  const now = new Date("2026-09-04T12:00:00+09:00");
  const pastDash = liveDashboard("2026-09-03");
  const db = memoryDb([
    {
      date: new Date("2026-09-03T00:00:00"),
      payload: toDailyOpsSnapshotPayload(pastDash),
      schemaVersion: 1,
      capturedAt: new Date("2026-09-04T00:30:00+09:00"),
    },
  ]);

  let sheetFetches = 0;
  const sourceFor = (ymd: string): AdminOpsDashboardSourceDeps => ({
    ...completeSourceDeps(ymd, { onOffFetch: () => { sheetFetches += 1; } }),
  });

  const today = await loadAdminOpsDashboardView("2026-09-04", {
    now,
    db,
    sourceDeps: sourceFor("2026-09-04"),
  });
  assert(today.source === "live" && today.snapshotAvailable === false, "오늘 → live");
  assert(today.sourceQuality === "complete", "오늘 complete source");
  assert(today.caddies.some((c) => c.name === "이제이"), "오늘 live 데이터");
  assert(today.isPastDate === false, "오늘은 과거 아님");
  assert(sheetFetches === 1, "오늘 live는 OFF Sheet를 읽음");

  const fetchesBeforeHist = sheetFetches;
  const hist = await loadAdminOpsDashboardView("2026-09-03", {
    now,
    db,
    sourceDeps: sourceFor("2026-09-03"),
  });
  assert(hist.source === "snapshot" && hist.snapshotAvailable === true, "과거+snapshot → snapshot");
  assert(hist.sourceQuality === "snapshot", "snapshot quality");
  assert(hist.capturedAt?.startsWith("2026-09-03T15:30:00"), "capturedAt 제공");
  assert(hist.caddies.some((c) => c.id === 1 && c.name === "이제이" && c.team === "1조"), "snapshot 이름/조");
  assert(hist.caddies.some((c) => c.name === "김지윤" && c.status === "excluded"), "snapshot status");
  assert(sheetFetches === fetchesBeforeHist, "과거 snapshot 있음 → Sheet fetch 없음");

  const unmigrated: DailyOpsSnapshotDb = {
    dailyOpsSnapshot: {
      async findUnique() {
        throw { code: "P2021" };
      },
      async create() {
        throw new Error("should not create");
      },
    },
  };
  const beforeTable = sheetFetches;
  const noTable = await loadAdminOpsDashboardView("2026-09-01", {
    now,
    db: unmigrated,
    sourceDeps: sourceFor("2026-09-01"),
  });
  assert(noTable.source === "live" && noTable.isPastDate === true, "미적용 migration → live fallback");
  assert(sheetFetches === beforeTable + 1, "P2021 후 live reconstruction");

  const missing = await loadAdminOpsDashboardView("2026-09-01", {
    now,
    db,
    sourceDeps: sourceFor("2026-09-01"),
  });
  assert(missing.source === "live" && missing.snapshotAvailable === false, "과거+없음 → live");
  assert(missing.isPastDate === true, "과거 metadata");
  assert(missing.reconstructedFromCurrentRoster === true, "재구성 표시");
}

section("KST 전날 계산");
{
  assert(kstYmd(new Date("2026-09-03T15:29:00.000Z")) === "2026-09-04", "15:29 UTC = 00:29 KST 다음날");
  assert(previousKstYmd(new Date("2026-09-03T15:30:00.000Z")) === "2026-09-03", "00:30 KST cron 대상 = 전날");
  assert(previousKstYmd(new Date("2026-09-03T16:30:00.000Z")) === "2026-09-03", "01:30 KST 재시도도 같은 전날");
  assert(previousKstYmd(new Date("2026-09-03T17:30:00.000Z")) === "2026-09-03", "02:30 KST 재시도도 같은 전날");
  assert(previousKstYmd(new Date("2026-09-03T14:59:00.000Z")) === "2026-09-02", "23:59 KST 전날");
  assert(formatCapturedAtKst("2026-09-03T15:30:00.000Z") === "2026.09.04 00:30", "저장시각 KST 표기");
}

section("OFF/ops 불완전 → snapshot skip");
{
  const db = memoryDb();
  const offFail = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [storedDuty("이제이")],
      fetchOffSheets: async () => {
        throw new Error("off_sheet_fetch_failed");
      },
    },
  });
  assert(offFail.status === "skipped", "OFF Sheet fetch 실패 → snapshot skip");
  assert(offFail.reason === "off_sheet_fetch_failed", "OFF 실패 reason");
  assert(
    (await db.dailyOpsSnapshot.findUnique({ where: { date: new Date("2026-09-03T00:00:00") } })) === null,
    "불완전 데이터 freeze 안 함"
  );

  const offMissingDate = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [storedDuty("이제이")],
      fetchOffSheets: async () => [offSheetForDate("2026-08-01", ["김지윤"])],
    },
  });
  assert(offMissingDate.status === "skipped", "OFF 날짜 없음 → skip");
  assert(offMissingDate.reason === "off_sheet_date_not_found", "OFF 날짜 미발견 reason");

  const dutyEmpty = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [],
      fetchOffSheets: async () => [offSheetForDate("2026-09-03", ["김지윤"])],
      fetchOpsDutySheets: async () =>
        buildOpsDutySheetTestSheets([
          {
            name: "0901~0914",
            startDate: "2026-09-03",
            week1Dates: ["2026-09-03", "2099-01-02", "2099-01-03", "2099-01-04", "2099-01-05", "2099-01-06", "2099-01-07"],
            week2Dates: ["2099-01-08", "2099-01-09", "2099-01-10", "2099-01-11", "2099-01-12", "2099-01-13", "2099-01-14"],
            week1Names: [{}],
          },
        ]),
    },
  });
  assert(dutyEmpty.status === "skipped", "운영배치 Sheet 비어 있으면 skip");
  assert(dutyEmpty.reason === "ops_duty_sheet_empty", "duty empty reason");

  const dutyFail = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [],
      fetchOffSheets: async () => [offSheetForDate("2026-09-03", ["김지윤"])],
      fetchOpsDutySheets: async () => {
        throw new Error("ops_duty_sheet_failed");
      },
    },
  });
  assert(dutyFail.status === "skipped", "운영배치 Sheet fetch 실패 → skip");
  assert(dutyFail.reason === "ops_duty_sheet_failed", "duty fetch reason");

  const fromSheet = await captureDailyOpsSnapshot("2026-09-03", {
    db,
    now: new Date("2026-09-04T00:30:00+09:00"),
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [],
      fetchOffSheets: async () => [offSheetForDate("2026-09-03", ["김지윤"])],
      fetchOpsDutySheets: async () => opsSheetsForDate("2026-09-03"),
    },
  });
  assert(fromSheet.status === "created", "운영배치 Sheet read-only로도 capture 가능");
}

section("live Sheet 실패 → fallback metadata");
{
  const now = new Date("2026-09-04T12:00:00+09:00");
  const view = await loadAdminOpsDashboardView("2026-09-04", {
    now,
    db: memoryDb(),
    sourceDeps: {
      loadAvailability: mockLoadAvailability(),
      listDuties: async () => [storedDuty("이제이")],
      fetchOffSheets: async () => {
        throw new Error("off_sheet_fetch_failed");
      },
    },
  });
  assert(view.source === "live" && view.sourceQuality === "fallback", "dashboard Sheet 실패 → fallback");
  assert(view.snapshotAvailable === false, "live fallback은 snapshot 아님");
}

section("dashboard GET write 없음 / cron 인증 / sheet read-only");
{
  const get = readSrc("src/app/api/manage/dashboard/route.ts");
  const cron = readSrc("src/app/api/cron/daily-ops-snapshot/route.ts");
  const service = readSrc("src/lib/dailyOpsSnapshotService.ts");
  const source = readSrc("src/lib/adminOpsDashboardSource.ts");
  const live = readSrc("src/lib/adminOpsDashboardService.ts");
  const vercel = readSrc("vercel.json");
  const schema = readSrc("prisma/schema.prisma");
  const sql = readSrc("prisma/migrations/20260903224000_daily_ops_snapshot/migration.sql");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  const getFn = get.split("export async function GET")[1] || "";

  assert(/loadAdminOpsDashboardView/.test(getFn), "GET이 historical view");
  assert(!/captureDailyOpsSnapshot/.test(get), "GET이 snapshot 생성 안 함");
  assert(!/prisma\.(create|update|upsert|delete)/.test(getFn), "GET에 prisma write 없음");
  assert(/requireAdmin/.test(get), "dashboard GET requireAdmin");
  assert(/fetchPublishedOffSheets/.test(source) && /fetchPublishedOpsDutySheets/.test(source), "source가 Sheet read");
  assert(/completeForSnapshot/.test(service) && /status: "skipped"/.test(service), "불완전 source는 skip");
  assert(/loadAdminOpsDashboardSource/.test(live), "live service가 공통 source 사용");
  assert(!/syncOpsDutySheet|replaceDailyOpsDuties|applyDailyOpsDutySheet/.test(service + cron + source), "capture에 duty write 없음");
  assert(/authorizeCronRequest/.test(cron) && /previousKstYmd/.test(cron), "cron 인증+전날");
  assert(/30 15 \* \* \*/.test(vercel) && /30 16 \* \* \*/.test(vercel) && /30 17 \* \* \*/.test(vercel), "15/16/17:30 UTC = 00/01/02:30 KST");
  assert((vercel.match(/daily-ops-snapshot/g) || []).length === 3, "같은 path 최대 3회");
  assert(/model DailyOpsSnapshot/.test(schema) && /date\s+DateTime\s+@unique/.test(schema), "date unique");
  assert(/CREATE TABLE "DailyOpsSnapshot"/.test(sql) && !/DROP TABLE/.test(sql), "additive migration");
  assert(/저장된 운영기록/.test(ui) && /저장된 과거기록 없음/.test(ui) && /현재 운영자료 기준/.test(ui), "metadata 문구");
  assert(/Sheet 일부 미반영/.test(ui), "fallback metadata 문구");
}

section("UI metadata / cron auth");
{
  process.env.CRON_SECRET = "test-cron-secret";
  assert(
    authorizeCronRequest({
      headers: { get: (n) => (n === "authorization" ? "Bearer test-cron-secret" : null) },
    }),
    "CRON_SECRET Bearer 허용"
  );
  assert(
    !authorizeCronRequest({
      headers: { get: (n) => (n === "authorization" ? "Bearer other" : null) },
    }),
    "잘못된 secret 거부"
  );
  assert(
    dashboardSourceLine({
      source: "snapshot",
      snapshotAvailable: true,
      capturedAt: "2026-09-03T15:30:00.000Z",
      isPastDate: true,
      sourceQuality: "snapshot",
    }).includes("저장된 운영기록") &&
      dashboardSourceLine({
        source: "snapshot",
        snapshotAvailable: true,
        capturedAt: "2026-09-03T15:30:00.000Z",
        isPastDate: true,
        sourceQuality: "snapshot",
      }).includes("2026.09.04 00:30"),
    "snapshot 상태 문구"
  );
  assert(
    dashboardSourceLine({
      source: "live",
      snapshotAvailable: false,
      capturedAt: null,
      isPastDate: true,
      sourceQuality: "fallback",
    }) === "저장된 과거기록 없음 · 현재 자료 기준 재구성",
    "snapshot 없는 과거 문구"
  );
  assert(
    dashboardSourceLine({
      source: "live",
      snapshotAvailable: false,
      capturedAt: null,
      isPastDate: false,
      sourceQuality: "complete",
    }) === "선택일 운영현황 · 현재 운영자료 기준",
    "오늘 complete 문구"
  );
  assert(
    dashboardSourceLine({
      source: "live",
      snapshotAvailable: false,
      capturedAt: null,
      isPastDate: false,
      sourceQuality: "fallback",
    }) === "선택일 운영현황 · 현재 자료 기준 (Sheet 일부 미반영)",
    "오늘 fallback 문구"
  );
  const parsed = parseDailyOpsSnapshotPayload(
    { date: "2026-09-03", caddies: [{ caddyId: 9, name: "보존", team: "3조", status: "available" }] },
    "2026-09-03"
  );
  const view = dashboardViewFromSnapshot({
    ymd: "2026-09-03",
    payload: parsed,
    capturedAt: new Date("2026-09-04T00:30:00+09:00"),
  });
  assert(view.caddies[0]?.name === "보존" && view.caddies[0]?.team === "3조", "hydrate name/team");
}

section("admin access / 기존 dashboard UI 유지");
{
  const layout = readSrc("src/app/manage/layout.tsx");
  const mw = readSrc("src/middleware.ts");
  const api = readSrc("src/app/api/manage/dashboard/route.ts");
  const ui = readSrc("src/components/manage/AdminOpsDashboard.tsx");
  const css = readSrc("src/app/globals.css");
  assert(/auth\.role !== "admin"/.test(layout), "layout admin only");
  assert(/role !== "admin"/.test(mw.split('pathname.startsWith("/manage")')[1] || mw), "middleware /manage admin");
  assert(/requireAdmin/.test(api), "dashboard GET requireAdmin");
  assert(/AdminOpsDutyBoard/.test(ui) && /AdminOpsTeamBoard/.test(ui), "기존 당번/조별 UI");
  assert(/\.dash-team-board\s*\{[^}]*repeat\(4/.test(css), "조별 4열 유지");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
