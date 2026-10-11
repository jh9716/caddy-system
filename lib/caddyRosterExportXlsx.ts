/**
 * 캐디 명단 V2 XLSX export / template.
 *
 * - DB write 없음. 현재 명단을 시트에 채우거나 빈 템플릿 행만 만든다.
 * - 기존 CSV export / import preview·apply 엔진을 변경하지 않는다.
 * - formula escape 는 CSV export와 동일한 escapeCsvFormulaCell 을 재사용한다.
 */

import * as XLSX from "xlsx";
import { filterArchivedCaddies } from "../src/lib/caddyArchiveVisibility";
import {
  DRIVING_POOL_TEAM,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_STATUSES,
  PRIMARY_TEAMS,
  THIRD_BAND_SUBGROUP_LABELS,
  THIRD_BAND_SUBGROUPS,
  isDrivingCaddyType,
  occupiesHouseThirdSlot,
  thirdBandSubgroupCsvLabel,
  type ThirdBandSubgroup,
} from "../src/lib/caddyManage";
import { escapeCsvFormulaCell } from "./caddyRosterImportV2";

export const CADDY_ROSTER_XLSX_SHEET_NAMES = [
  "_안내",
  "_코드표",
  "기존캐디",
  "신규캐디",
  "퇴사",
  "드라이빙",
] as const;

export type CaddyRosterXlsxSheetName =
  (typeof CADDY_ROSTER_XLSX_SHEET_NAMES)[number];

export const EXISTING_CADDY_XLSX_HEADERS = [
  "id",
  "name",
  "team",
  "teamOrder",
  "employmentStatus",
  "phone",
  "thirdBandSubgroup",
] as const;

export const NEW_CADDY_XLSX_HEADERS = [
  "name",
  "team",
  "teamOrder",
  "employmentStatus",
  "phone",
  "thirdBandSubgroup",
] as const;

export const RETIRE_CADDY_XLSX_HEADERS = ["id", "name", "reason"] as const;

export const DRIVING_CADDY_XLSX_HEADERS = [
  "id",
  "name",
  "phone",
  "employmentStatus",
] as const;

export const CADDY_ROSTER_XLSX_TEMPLATE_EMPTY_ROWS = 10;

/** parseImportEmploymentStatus 가 받는 값. enum 행은 EMPLOYMENT_STATUSES. */
export const EMPLOYMENT_STATUS_CODE_TABLE: ReadonlyArray<{
  value: string;
  note: string;
}> = [
  ...EMPLOYMENT_STATUSES.map((value) => ({
    value,
    note: `DB enum / export 표기. ${EMPLOYMENT_STATUS_LABELS[value]}`,
  })),
  { value: "재직", note: "import 별칭 → ACTIVE" },
  { value: "휴직", note: "import 별칭 → LEAVE" },
  { value: "퇴사", note: "import 별칭 → RETIRED" },
];

/** parseThirdBandSubgroupInput / export CSV 라벨과 동일한 허용값. */
export const THIRD_BAND_SUBGROUP_CODE_TABLE: ReadonlyArray<{
  value: string;
  note: string;
}> = [
  { value: "일반", note: "export 라벨. DB null (3부구분 없음)" },
  ...THIRD_BAND_SUBGROUPS.map((value) => ({
    value: THIRD_BAND_SUBGROUP_LABELS[value],
    note: `export 라벨 → ${value}`,
  })),
  ...THIRD_BAND_SUBGROUPS.map((value) => ({
    value,
    note: "DB enum",
  })),
  { value: "주중반", note: "import 별칭 → WEEKDAY" },
  { value: "주말반", note: "import 별칭 → WEEKEND" },
  { value: "NONE", note: "import 별칭 → null (일반)" },
];

export const CADDY_ROSTER_XLSX_GUIDE_LINES = [
  "캐디 명단 V2 Excel 템플릿",
  "",
  "이 파일을 내려받는 것만으로는 DB가 변경되지 않습니다.",
  "실제 DB 적용은 이후 import preview → 관리자 확인 → apply 단계에서만 이루어집니다. (후속)",
  "",
  "시트",
  "- _안내: 이 설명",
  "- _코드표: 현재 코드 기준 허용값. 임의 값을 만들지 마세요.",
  "- 기존캐디: 현재 일반(1~12조) 명단. 수정 대상.",
  "- 신규캐디: 신규 등록용 빈 템플릿",
  "- 퇴사: 퇴사(삭제됨) 처리 입력용 빈 템플릿",
  "- 드라이빙: 현재 드라이빙 전담 명단",
  "",
  "매칭 (후속 import 예정 규칙)",
  "- 기존 캐디 수정은 id 기준입니다. id 열을 바꾸거나 비우지 마세요.",
  "- 이름만으로 매칭하지 않을 예정입니다.",
  "- 파일에서 행이 빠졌다고 자동 퇴사되지 않습니다.",
  "",
  "작성",
  "- 조 / 재직상태 / 3부구분은 _코드표 값만 사용하세요.",
  "- 빈 칸은 기존 값 유지로 해석될 예정입니다 (후속 import).",
  "- 퇴사 처리는 퇴사 시트에 id와 이름을 명시하세요. 기존캐디에서 행을 지워도 퇴사가 아닙니다.",
] as const;

export type RosterExportXlsxRow = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
  phoneNormalized?: string | null;
  thirdBandSubgroup?: string | null;
  caddyType?: string | null;
};

export function exportEmploymentStatusLabel(
  value: string | null | undefined
): string {
  const v = String(value ?? "").trim();
  const upper = v.toUpperCase();
  if (upper === "ACTIVE" || v === "재직") return "ACTIVE";
  if (upper === "LEAVE" || v === "휴직") return "LEAVE";
  if (upper === "RETIRED" || v === "퇴사") return "RETIRED";
  return v || "ACTIVE";
}

export function isDrivingExportRow(row: {
  caddyType?: string | null;
  team?: string | null;
}): boolean {
  return (
    isDrivingCaddyType(row.caddyType) ||
    String(row.team ?? "").trim() === DRIVING_POOL_TEAM
  );
}

export function partitionRosterExportXlsxRows<T extends RosterExportXlsxRow>(
  rows: readonly T[]
): { existing: T[]; driving: T[] } {
  const existing: T[] = [];
  const driving: T[] = [];
  for (const row of rows) {
    if (isDrivingExportRow(row)) {
      driving.push(row);
      continue;
    }
    if (occupiesHouseThirdSlot(row)) {
      existing.push(row);
    }
  }
  return { existing, driving };
}

export function visibleRosterExportXlsxRows<T extends RosterExportXlsxRow>(
  rows: readonly T[],
  canReadArchived: boolean
): T[] {
  return filterArchivedCaddies(rows, canReadArchived);
}

function safeText(value: unknown): string {
  return escapeCsvFormulaCell(String(value ?? ""));
}

function aoaToSafeSheet(
  aoa: Array<Array<string | number | null | undefined>>
): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const ref = ws["!ref"];
  if (!ref) return ws;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      if (!cell) continue;
      if (typeof cell.v === "string") {
        cell.t = "s";
        delete cell.f;
      }
    }
  }
  return ws;
}

function emptyTemplateRows(
  columnCount: number,
  count = CADDY_ROSTER_XLSX_TEMPLATE_EMPTY_ROWS
): Array<Array<string>> {
  return Array.from({ length: count }, () => Array(columnCount).fill(""));
}

function buildGuideSheet(): XLSX.WorkSheet {
  return aoaToSafeSheet(CADDY_ROSTER_XLSX_GUIDE_LINES.map((line) => [safeText(line)]));
}

function buildCodeSheet(): XLSX.WorkSheet {
  const aoa: Array<Array<string>> = [
    [safeText("구분"), safeText("값"), safeText("설명")],
  ];
  for (const team of PRIMARY_TEAMS) {
    aoa.push([
      safeText("team"),
      safeText(team),
      safeText("일반 1~12조. 기존캐디·신규캐디"),
    ]);
  }
  aoa.push([
    safeText("team"),
    safeText(DRIVING_POOL_TEAM),
    safeText("드라이빙 전담 가상 조. 드라이빙 시트"),
  ]);
  for (const row of EMPLOYMENT_STATUS_CODE_TABLE) {
    aoa.push([
      safeText("employmentStatus"),
      safeText(row.value),
      safeText(row.note),
    ]);
  }
  for (const row of THIRD_BAND_SUBGROUP_CODE_TABLE) {
    aoa.push([
      safeText("thirdBandSubgroup"),
      safeText(row.value),
      safeText(row.note),
    ]);
  }
  return aoaToSafeSheet(aoa);
}

function buildExistingSheet(rows: readonly RosterExportXlsxRow[]): XLSX.WorkSheet {
  const aoa: Array<Array<string | number>> = [
    EXISTING_CADDY_XLSX_HEADERS.map((h) => safeText(h)),
  ];
  for (const row of rows) {
    aoa.push([
      row.id,
      safeText(row.name),
      safeText(row.team),
      Number(row.teamOrder) || 0,
      safeText(exportEmploymentStatusLabel(row.employmentStatus)),
      safeText(row.phoneNormalized ?? ""),
      safeText(
        thirdBandSubgroupCsvLabel(
          (row.thirdBandSubgroup as ThirdBandSubgroup | null | undefined) ?? null
        )
      ),
    ]);
  }
  return aoaToSafeSheet(aoa);
}

function buildNewCaddySheet(): XLSX.WorkSheet {
  return aoaToSafeSheet([
    NEW_CADDY_XLSX_HEADERS.map((h) => safeText(h)),
    ...emptyTemplateRows(NEW_CADDY_XLSX_HEADERS.length),
  ]);
}

function buildRetireSheet(): XLSX.WorkSheet {
  return aoaToSafeSheet([
    RETIRE_CADDY_XLSX_HEADERS.map((h) => safeText(h)),
    ...emptyTemplateRows(RETIRE_CADDY_XLSX_HEADERS.length),
  ]);
}

function buildDrivingSheet(rows: readonly RosterExportXlsxRow[]): XLSX.WorkSheet {
  const aoa: Array<Array<string | number>> = [
    DRIVING_CADDY_XLSX_HEADERS.map((h) => safeText(h)),
  ];
  for (const row of rows) {
    aoa.push([
      row.id,
      safeText(row.name),
      safeText(row.phoneNormalized ?? ""),
      safeText(exportEmploymentStatusLabel(row.employmentStatus)),
    ]);
  }
  return aoaToSafeSheet(aoa);
}

export function buildRosterExportXlsxWorkbook(
  rows: readonly RosterExportXlsxRow[],
  options?: { canReadArchived?: boolean }
): XLSX.WorkBook {
  const visible = visibleRosterExportXlsxRows(
    rows,
    options?.canReadArchived === true
  );
  const { existing, driving } = partitionRosterExportXlsxRows(visible);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildGuideSheet(), "_안내");
  XLSX.utils.book_append_sheet(wb, buildCodeSheet(), "_코드표");
  XLSX.utils.book_append_sheet(wb, buildExistingSheet(existing), "기존캐디");
  XLSX.utils.book_append_sheet(wb, buildNewCaddySheet(), "신규캐디");
  XLSX.utils.book_append_sheet(wb, buildRetireSheet(), "퇴사");
  XLSX.utils.book_append_sheet(wb, buildDrivingSheet(driving), "드라이빙");
  return wb;
}

export function buildRosterExportXlsxBuffer(
  rows: readonly RosterExportXlsxRow[],
  options?: { canReadArchived?: boolean }
): Buffer {
  const wb = buildRosterExportXlsxWorkbook(rows, options);
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

export function readRosterExportXlsxSheets(buffer: Buffer): {
  sheetNames: string[];
  sheets: Record<string, Array<Array<string | number>>>;
} {
  const wb = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  const sheets: Record<string, Array<Array<string | number>>> = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    sheets[name] = XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
      header: 1,
      raw: true,
      defval: "",
    });
  }
  return { sheetNames: wb.SheetNames, sheets };
}

export function rosterExportXlsxHasStoredFormula(buffer: Buffer): boolean {
  const wb = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const ref = ws["!ref"];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })] as
          | XLSX.CellObject
          | undefined;
        if (cell?.f) return true;
      }
    }
  }
  return false;
}
