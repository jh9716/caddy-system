/**
 * 캐디 명단 V2 workbook preview (DELTA, id matching only).
 *
 * - DB write 없음. existing rows는 읽기 전용 스냅샷.
 * - 이름-only 매칭 금지. 수정/퇴사/드라이빙 변경은 Caddy.id 만.
 * - 파일에서 빠진 기존 캐디는 퇴사/누락이 아니다.
 * - 기존 import v2 apply 엔진을 호출·변경하지 않는다.
 */

import * as XLSX from "xlsx";
import { denyArchivedCaddyRead } from "../src/lib/caddyArchiveVisibility";
import {
  DRIVING_POOL_TEAM,
  drivingPersistFields,
  isPrimaryTeam,
  occupiesHouseThirdSlot,
  parseImportThirdBandSubgroup,
  resolveCaddyTypeFromTeam,
  resolveThirdBandSubgroup,
  thirdBandSubgroupCsvLabel,
  ThirdBandSubgroupError,
  type ThirdBandSubgroup,
} from "../src/lib/caddyManage";
import {
  CaddyPhoneError,
  maskKrMobile,
  normalizeKrMobile,
} from "../src/lib/caddyPhone";
import {
  findSlotHoldingConflicts,
  getConfiguredSlotCapacity,
  isSlotHoldingStatus,
} from "../src/lib/caddySlot";
import {
  isNeedsReviewName,
  isNumericOnlyRosterName,
  levenshtein,
  normalizePersonName,
  parseImportEmploymentStatus,
  parseImportTeamOrder,
  type EmploymentStatusValue,
} from "./caddyImportRules";
import {
  DRIVING_CADDY_XLSX_HEADERS,
  EXISTING_CADDY_XLSX_HEADERS,
  NEW_CADDY_XLSX_HEADERS,
  RETIRE_CADDY_XLSX_HEADERS,
  type RosterExportXlsxRow,
} from "./caddyRosterExportXlsx";
import { unescapeCsvFormulaCell } from "./caddyRosterImportV2";

export const XLSX_V2_PREVIEW_MODE = "delta" as const;
export const XLSX_V2_PREVIEW_FORMAT = "xlsx-v2-workbook" as const;

const REQUIRED_SHEETS = ["기존캐디", "신규캐디", "퇴사", "드라이빙"] as const;

export type XlsxV2PreviewSheet =
  | "기존캐디"
  | "신규캐디"
  | "퇴사"
  | "드라이빙"
  | "_workbook";

export type XlsxV2PreviewIssue = {
  code: string;
  sheet: XlsxV2PreviewSheet;
  rowNumber: number;
  id: number | null;
  name: string;
  message: string;
};

export type XlsxV2FieldDiff = {
  key: string;
  before: string | null;
  after: string | null;
};

export type XlsxV2CreateLine = {
  sheet: "신규캐디";
  rowNumber: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: EmploymentStatusValue;
  phone: string | null;
  maskedPhone: string | null;
  thirdBandSubgroup: ThirdBandSubgroup | null;
  caddyType: "HOUSE" | "THIRD";
};

export type XlsxV2UpdateLine = {
  sheet: "기존캐디";
  rowNumber: number;
  id: number;
  name: string;
  fields: XlsxV2FieldDiff[];
};

export type XlsxV2RetireLine = {
  sheet: "퇴사";
  rowNumber: number;
  id: number;
  name: string;
  reason: string;
  currentEmploymentStatus: string;
};

export type XlsxV2DrivingChangeLine = {
  sheet: "드라이빙";
  rowNumber: number;
  id: number;
  name: string;
  kind: "update" | "convert_to_driving";
  fields: XlsxV2FieldDiff[];
};

export type XlsxV2WorkbookPreview = {
  mode: typeof XLSX_V2_PREVIEW_MODE;
  format: typeof XLSX_V2_PREVIEW_FORMAT;
  creates: XlsxV2CreateLine[];
  updates: XlsxV2UpdateLine[];
  retires: XlsxV2RetireLine[];
  drivingChanges: XlsxV2DrivingChangeLine[];
  warnings: XlsxV2PreviewIssue[];
  errors: XlsxV2PreviewIssue[];
  summary: {
    create: number;
    update: number;
    retire: number;
    drivingChange: number;
    unchanged: number;
    warning: number;
    error: number;
    omittedExisting: number;
    applyAvailable: false;
    applyBlocked: boolean;
  };
};

export type XlsxV2PreviewExisting = RosterExportXlsxRow;

export type XlsxV2PreviewOptions = {
  canReadArchived?: boolean;
};

type SafeCell = {
  text: string;
  formula: boolean;
  numeric: boolean;
  number: number | null;
};

type ParsedExistingRow = {
  rowNumber: number;
  id: number | null;
  nameRaw: string;
  teamRaw: string;
  teamOrderRaw: string;
  employmentRaw: string;
  phoneRaw: string;
  thirdBandRaw: string;
  formula: boolean;
};

type ParsedNewRow = {
  rowNumber: number;
  idRaw: string;
  nameRaw: string;
  teamRaw: string;
  teamOrderRaw: string;
  employmentRaw: string;
  phoneRaw: string;
  thirdBandRaw: string;
  formula: boolean;
};

type ParsedRetireRow = {
  rowNumber: number;
  id: number | null;
  nameRaw: string;
  reasonRaw: string;
  formula: boolean;
};

type ParsedDrivingRow = {
  rowNumber: number;
  id: number | null;
  nameRaw: string;
  phoneRaw: string;
  employmentRaw: string;
  formula: boolean;
};

function issue(
  code: string,
  sheet: XlsxV2PreviewSheet,
  rowNumber: number,
  id: number | null,
  name: string,
  message: string
): XlsxV2PreviewIssue {
  return { code, sheet, rowNumber, id, name, message };
}

function emptyPreview(
  extras?: Partial<Pick<XlsxV2WorkbookPreview, "errors" | "warnings">>
): XlsxV2WorkbookPreview {
  const errors = extras?.errors ?? [];
  const warnings = extras?.warnings ?? [];
  return {
    mode: XLSX_V2_PREVIEW_MODE,
    format: XLSX_V2_PREVIEW_FORMAT,
    creates: [],
    updates: [],
    retires: [],
    drivingChanges: [],
    warnings,
    errors,
    summary: {
      create: 0,
      update: 0,
      retire: 0,
      drivingChange: 0,
      unchanged: 0,
      warning: warnings.length,
      error: errors.length,
      omittedExisting: 0,
      applyAvailable: false,
      applyBlocked: errors.length > 0,
    },
  };
}

function readCell(cell: XLSX.CellObject | undefined): SafeCell {
  if (!cell) {
    return { text: "", formula: false, numeric: false, number: null };
  }
  if (cell.f) {
    return { text: "", formula: true, numeric: false, number: null };
  }
  const isNumeric = cell.t === "n" || typeof cell.v === "number";
  if (isNumeric) {
    const num = typeof cell.v === "number" ? cell.v : Number(cell.v);
    return {
      text: Number.isFinite(num) ? String(num) : "",
      formula: false,
      numeric: true,
      number: Number.isFinite(num) ? num : null,
    };
  }
  const raw = cell.v == null ? "" : String(cell.v);
  return {
    text: unescapeCsvFormulaCell(raw.trim()),
    formula: false,
    numeric: false,
    number: null,
  };
}

function headerKey(value: string): string {
  return unescapeCsvFormulaCell(String(value ?? "").trim()).toLowerCase();
}

function headerIndex(
  headerRow: SafeCell[],
  names: readonly string[]
): { index: Record<string, number>; missing: string[] } {
  const index: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const key = headerKey(headerRow[i]?.text ?? "");
    if (key) index[key] = i;
  }
  const missing = names.filter((name) => index[headerKey(name)] == null);
  return { index, missing };
}

function cellAt(row: SafeCell[], index: Record<string, number>, name: string): SafeCell {
  const i = index[headerKey(name)];
  if (i == null) return { text: "", formula: false, numeric: false, number: null };
  return row[i] ?? { text: "", formula: false, numeric: false, number: null };
}

function parseIdCell(cell: SafeCell): number | null {
  if (cell.formula) return null;
  if (cell.numeric && cell.number != null) {
    if (!Number.isInteger(cell.number) || cell.number < 1) return null;
    return cell.number;
  }
  const raw = cell.text.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function phoneFromCell(cell: SafeCell): { phoneRaw: string; error?: string } {
  if (cell.formula) {
    return { phoneRaw: "", error: "수식 셀은 사용하지 않습니다." };
  }
  if (cell.numeric && cell.number != null) {
    const digits = String(cell.number).replace(/\.0$/, "");
    if (/^10\d{8}$/.test(digits)) {
      return {
        phoneRaw: "",
        error:
          "휴대폰이 Excel 숫자 셀로 읽혀 앞자리 0이 사라졌습니다. 텍스트로 저장하세요. 0을 추정하지 않습니다.",
      };
    }
    return { phoneRaw: digits };
  }
  return { phoneRaw: unescapeCsvFormulaCell(cell.text.trim()) };
}

function sheetToRows(ws: XLSX.WorkSheet | undefined): SafeCell[][] {
  if (!ws || !ws["!ref"]) return [];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const rows: SafeCell[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: SafeCell[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      row.push(
        readCell(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined)
      );
    }
    rows.push(row);
  }
  return rows;
}

function isBlankCells(cells: SafeCell[]): boolean {
  return cells.every((c) => !c.formula && !c.text.trim() && !c.numeric);
}

function classifyNameVerification(
  fileName: string,
  dbName: string
): "ok" | "warning" | "error" {
  const a = normalizePersonName(fileName);
  const b = normalizePersonName(dbName);
  if (!a) return "ok";
  if (a === b) return "ok";
  return levenshtein(a, b) <= 1 ? "warning" : "error";
}

function lookupExisting(
  id: number,
  byId: Map<number, XlsxV2PreviewExisting>,
  canReadArchived: boolean
): XlsxV2PreviewExisting | null {
  const row = byId.get(id);
  if (!row) return null;
  if (denyArchivedCaddyRead(row.employmentStatus, canReadArchived)) return null;
  return row;
}

function empLabel(value: string | null | undefined): string {
  const parsed = (() => {
    try {
      return parseImportEmploymentStatus(value ?? "");
    } catch {
      return null;
    }
  })();
  if (parsed) return parsed;
  const raw = String(value ?? "").trim().toUpperCase();
  return raw || "ACTIVE";
}

function subgroupLabel(value: ThirdBandSubgroup | null | undefined): string {
  return thirdBandSubgroupCsvLabel(value ?? null);
}

function readWorkbookOrError(
  buffer: Buffer
): { wb: XLSX.WorkBook } | { error: XlsxV2PreviewIssue } {
  try {
    const wb = XLSX.read(buffer, {
      type: "buffer",
      cellDates: false,
      cellFormula: true,
      raw: true,
    });
    if (!wb.SheetNames.length) {
      return {
        error: issue(
          "empty_workbook",
          "_workbook",
          0,
          null,
          "",
          "XLSX에 시트가 없습니다."
        ),
      };
    }
    return { wb };
  } catch (e) {
    return {
      error: issue(
        "unreadable_xlsx",
        "_workbook",
        0,
        null,
        "",
        e instanceof Error ? e.message : "XLSX를 읽지 못했습니다."
      ),
    };
  }
}

function parseExistingSheet(
  rows: SafeCell[][],
  errors: XlsxV2PreviewIssue[]
): ParsedExistingRow[] {
  if (!rows.length) {
    errors.push(
      issue("missing_header", "기존캐디", 1, null, "", "기존캐디 헤더가 없습니다.")
    );
    return [];
  }
  const { index, missing } = headerIndex(rows[0], EXISTING_CADDY_XLSX_HEADERS);
  if (missing.length) {
    errors.push(
      issue(
        "invalid_header",
        "기존캐디",
        1,
        null,
        "",
        `기존캐디 헤더 누락: ${missing.join(", ")}`
      )
    );
    return [];
  }
  const out: ParsedExistingRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    if (isBlankCells(row)) continue;
    const idCell = cellAt(row, index, "id");
    const nameCell = cellAt(row, index, "name");
    const teamCell = cellAt(row, index, "team");
    const orderCell = cellAt(row, index, "teamOrder");
    const empCell = cellAt(row, index, "employmentStatus");
    const phoneCell = cellAt(row, index, "phone");
    const bandCell = cellAt(row, index, "thirdBandSubgroup");
    const formula =
      idCell.formula ||
      nameCell.formula ||
      teamCell.formula ||
      orderCell.formula ||
      empCell.formula ||
      phoneCell.formula ||
      bandCell.formula;
    const idText = idCell.text.trim();
    const id = parseIdCell(idCell);
    if (formula) {
      errors.push(
        issue(
          "formula_not_allowed",
          "기존캐디",
          rowNumber,
          id,
          nameCell.text,
          "수식 셀은 실행하거나 결과값을 신뢰하지 않습니다."
        )
      );
    }
    if (!idText && !idCell.numeric) {
      errors.push(
        issue(
          "id_required",
          "기존캐디",
          rowNumber,
          null,
          nameCell.text,
          "기존캐디 행은 id가 필요합니다. id 없는 행을 신규로 해석하지 않습니다."
        )
      );
    } else if (id == null) {
      errors.push(
        issue(
          "invalid_id",
          "기존캐디",
          rowNumber,
          null,
          nameCell.text,
          `id가 올바르지 않습니다: ${idText || idCell.number}`
        )
      );
    }
    const phone = phoneFromCell(phoneCell);
    if (phone.error) {
      errors.push(
        issue(
          "invalid_phone",
          "기존캐디",
          rowNumber,
          id,
          nameCell.text,
          phone.error
        )
      );
    }
    out.push({
      rowNumber,
      id,
      nameRaw: nameCell.text.trim(),
      teamRaw: teamCell.text.trim(),
      teamOrderRaw: orderCell.numeric && orderCell.number != null
        ? String(orderCell.number)
        : orderCell.text.trim(),
      employmentRaw: empCell.text.trim(),
      phoneRaw: phone.phoneRaw,
      thirdBandRaw: bandCell.text.trim(),
      formula,
    });
  }
  return out;
}

function parseNewSheet(
  rows: SafeCell[][],
  errors: XlsxV2PreviewIssue[]
): ParsedNewRow[] {
  if (!rows.length) {
    errors.push(
      issue("missing_header", "신규캐디", 1, null, "", "신규캐디 헤더가 없습니다.")
    );
    return [];
  }
  const { index, missing } = headerIndex(rows[0], NEW_CADDY_XLSX_HEADERS);
  if (missing.length) {
    errors.push(
      issue(
        "invalid_header",
        "신규캐디",
        1,
        null,
        "",
        `신규캐디 헤더 누락: ${missing.join(", ")}`
      )
    );
    return [];
  }
  const idIdx = headerIndex(rows[0], ["id"]).index.id;
  const out: ParsedNewRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    if (isBlankCells(row)) continue;
    const nameCell = cellAt(row, index, "name");
    const teamCell = cellAt(row, index, "team");
    const orderCell = cellAt(row, index, "teamOrder");
    const empCell = cellAt(row, index, "employmentStatus");
    const phoneCell = cellAt(row, index, "phone");
    const bandCell = cellAt(row, index, "thirdBandSubgroup");
    const idCell =
      idIdx != null
        ? row[idIdx] ?? { text: "", formula: false, numeric: false, number: null }
        : { text: "", formula: false, numeric: false, number: null };
    const formula =
      nameCell.formula ||
      teamCell.formula ||
      orderCell.formula ||
      empCell.formula ||
      phoneCell.formula ||
      bandCell.formula ||
      idCell.formula;
    if (formula) {
      errors.push(
        issue(
          "formula_not_allowed",
          "신규캐디",
          rowNumber,
          null,
          nameCell.text,
          "수식 셀은 실행하거나 결과값을 신뢰하지 않습니다."
        )
      );
    }
    if (idCell.text.trim() || (idCell.numeric && idCell.number != null)) {
      errors.push(
        issue(
          "create_must_not_have_id",
          "신규캐디",
          rowNumber,
          parseIdCell(idCell),
          nameCell.text,
          "신규캐디 시트에는 id를 넣지 마세요."
        )
      );
    }
    const phone = phoneFromCell(phoneCell);
    if (phone.error) {
      errors.push(
        issue(
          "invalid_phone",
          "신규캐디",
          rowNumber,
          null,
          nameCell.text,
          phone.error
        )
      );
    }
    out.push({
      rowNumber,
      idRaw: idCell.text.trim(),
      nameRaw: nameCell.text.trim(),
      teamRaw: teamCell.text.trim(),
      teamOrderRaw:
        orderCell.numeric && orderCell.number != null
          ? String(orderCell.number)
          : orderCell.text.trim(),
      employmentRaw: empCell.text.trim(),
      phoneRaw: phone.phoneRaw,
      thirdBandRaw: bandCell.text.trim(),
      formula,
    });
  }
  return out;
}

function parseRetireSheet(
  rows: SafeCell[][],
  errors: XlsxV2PreviewIssue[]
): ParsedRetireRow[] {
  if (!rows.length) {
    errors.push(issue("missing_header", "퇴사", 1, null, "", "퇴사 헤더가 없습니다."));
    return [];
  }
  const { index, missing } = headerIndex(rows[0], RETIRE_CADDY_XLSX_HEADERS);
  if (missing.length) {
    errors.push(
      issue(
        "invalid_header",
        "퇴사",
        1,
        null,
        "",
        `퇴사 헤더 누락: ${missing.join(", ")}`
      )
    );
    return [];
  }
  const out: ParsedRetireRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    if (isBlankCells(row)) continue;
    const idCell = cellAt(row, index, "id");
    const nameCell = cellAt(row, index, "name");
    const reasonCell = cellAt(row, index, "reason");
    const formula = idCell.formula || nameCell.formula || reasonCell.formula;
    const id = parseIdCell(idCell);
    if (formula) {
      errors.push(
        issue(
          "formula_not_allowed",
          "퇴사",
          rowNumber,
          id,
          nameCell.text,
          "수식 셀은 실행하거나 결과값을 신뢰하지 않습니다."
        )
      );
    }
    if (!idCell.text.trim() && !idCell.numeric) {
      errors.push(
        issue(
          "id_required",
          "퇴사",
          rowNumber,
          null,
          nameCell.text,
          "퇴사 대상은 id로만 결정합니다."
        )
      );
    } else if (id == null) {
      errors.push(
        issue(
          "invalid_id",
          "퇴사",
          rowNumber,
          null,
          nameCell.text,
          `id가 올바르지 않습니다: ${idCell.text || idCell.number}`
        )
      );
    }
    out.push({
      rowNumber,
      id,
      nameRaw: nameCell.text.trim(),
      reasonRaw: reasonCell.text.trim(),
      formula,
    });
  }
  return out;
}

function parseDrivingSheet(
  rows: SafeCell[][],
  errors: XlsxV2PreviewIssue[]
): ParsedDrivingRow[] {
  if (!rows.length) {
    errors.push(
      issue("missing_header", "드라이빙", 1, null, "", "드라이빙 헤더가 없습니다.")
    );
    return [];
  }
  const { index, missing } = headerIndex(rows[0], DRIVING_CADDY_XLSX_HEADERS);
  if (missing.length) {
    errors.push(
      issue(
        "invalid_header",
        "드라이빙",
        1,
        null,
        "",
        `드라이빙 헤더 누락: ${missing.join(", ")}`
      )
    );
    return [];
  }
  const out: ParsedDrivingRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;
    if (isBlankCells(row)) continue;
    const idCell = cellAt(row, index, "id");
    const nameCell = cellAt(row, index, "name");
    const phoneCell = cellAt(row, index, "phone");
    const empCell = cellAt(row, index, "employmentStatus");
    const formula =
      idCell.formula || nameCell.formula || phoneCell.formula || empCell.formula;
    const id = parseIdCell(idCell);
    if (formula) {
      errors.push(
        issue(
          "formula_not_allowed",
          "드라이빙",
          rowNumber,
          id,
          nameCell.text,
          "수식 셀은 실행하거나 결과값을 신뢰하지 않습니다."
        )
      );
    }
    if (!idCell.text.trim() && !idCell.numeric) {
      errors.push(
        issue(
          "id_required",
          "드라이빙",
          rowNumber,
          null,
          nameCell.text,
          "드라이빙 변경은 id가 필요합니다. 신규 생성은 신규캐디 시트만 사용합니다."
        )
      );
    } else if (id == null) {
      errors.push(
        issue(
          "invalid_id",
          "드라이빙",
          rowNumber,
          null,
          nameCell.text,
          `id가 올바르지 않습니다: ${idCell.text || idCell.number}`
        )
      );
    }
    const phone = phoneFromCell(phoneCell);
    if (phone.error) {
      errors.push(
        issue(
          "invalid_phone",
          "드라이빙",
          rowNumber,
          id,
          nameCell.text,
          phone.error
        )
      );
    }
    out.push({
      rowNumber,
      id,
      nameRaw: nameCell.text.trim(),
      phoneRaw: phone.phoneRaw,
      employmentRaw: empCell.text.trim(),
      formula,
    });
  }
  return out;
}

function parsePhoneOptional(
  raw: string,
  sheet: XlsxV2PreviewSheet,
  rowNumber: number,
  id: number | null,
  name: string,
  errors: XlsxV2PreviewIssue[]
): string | null | undefined {
  if (!raw.trim()) return undefined;
  try {
    return normalizeKrMobile(raw);
  } catch (e) {
    errors.push(
      issue(
        "invalid_phone",
        sheet,
        rowNumber,
        id,
        name,
        e instanceof CaddyPhoneError ? e.message : "유효한 휴대폰번호가 아닙니다."
      )
    );
    return undefined;
  }
}

function pushNameVerification(
  fileName: string,
  dbName: string,
  sheet: XlsxV2PreviewSheet,
  rowNumber: number,
  id: number,
  errors: XlsxV2PreviewIssue[],
  warnings: XlsxV2PreviewIssue[]
) {
  const kind = classifyNameVerification(fileName, dbName);
  if (kind === "ok") return;
  const msg = `이름 확인 불일치: 파일 "${fileName}" / DB "${dbName}". id ${id} 외 다른 사람과 매칭하지 않습니다.`;
  if (kind === "warning") {
    warnings.push(issue("name_mismatch", sheet, rowNumber, id, fileName, msg));
    return;
  }
  errors.push(issue("name_mismatch_severe", sheet, rowNumber, id, fileName, msg));
}

export function buildXlsxV2WorkbookPreview(
  buffer: Buffer,
  existing: readonly XlsxV2PreviewExisting[],
  options?: XlsxV2PreviewOptions
): XlsxV2WorkbookPreview {
  const existingSnapshot = existing.map((row) => ({ ...row }));
  const canReadArchived = options?.canReadArchived === true;
  const errors: XlsxV2PreviewIssue[] = [];
  const warnings: XlsxV2PreviewIssue[] = [];

  const read = readWorkbookOrError(buffer);
  if ("error" in read) return emptyPreview({ errors: [read.error] });

  const missingSheets = REQUIRED_SHEETS.filter(
    (name) => !read.wb.SheetNames.includes(name)
  );
  if (missingSheets.length) {
    return emptyPreview({
      errors: [
        issue(
          "missing_sheets",
          "_workbook",
          0,
          null,
          "",
          `V2 템플릿 시트가 없습니다: ${missingSheets.join(", ")}. P1 export.xlsx 를 사용하세요.`
        ),
      ],
    });
  }

  const existingRows = parseExistingSheet(
    sheetToRows(read.wb.Sheets["기존캐디"]),
    errors
  );
  const newRows = parseNewSheet(sheetToRows(read.wb.Sheets["신규캐디"]), errors);
  const retireRows = parseRetireSheet(sheetToRows(read.wb.Sheets["퇴사"]), errors);
  const drivingRows = parseDrivingSheet(
    sheetToRows(read.wb.Sheets["드라이빙"]),
    errors
  );

  const byId = new Map(existingSnapshot.map((row) => [row.id, row]));
  const usedIds = new Map<number, Array<{ sheet: XlsxV2PreviewSheet; rowNumber: number }>>();
  const noteId = (
    id: number | null,
    sheet: XlsxV2PreviewSheet,
    rowNumber: number
  ) => {
    if (id == null) return;
    const list = usedIds.get(id) ?? [];
    list.push({ sheet, rowNumber });
    usedIds.set(id, list);
  };
  for (const row of existingRows) noteId(row.id, "기존캐디", row.rowNumber);
  for (const row of retireRows) noteId(row.id, "퇴사", row.rowNumber);
  for (const row of drivingRows) noteId(row.id, "드라이빙", row.rowNumber);
  for (const [id, locs] of usedIds) {
    if (locs.length < 2) continue;
    for (const loc of locs) {
      errors.push(
        issue(
          "duplicate_id",
          loc.sheet,
          loc.rowNumber,
          id,
          "",
          `id ${id} 가 파일에서 ${locs.length}번 나왔습니다. 이름-only 재매칭 없이 거부합니다.`
        )
      );
    }
  }

  const filePhones = new Map<string, Array<{ sheet: XlsxV2PreviewSheet; rowNumber: number; name: string }>>();
  const trackPhone = (
    phone: string | null | undefined,
    sheet: XlsxV2PreviewSheet,
    rowNumber: number,
    name: string
  ) => {
    if (!phone) return;
    const list = filePhones.get(phone) ?? [];
    list.push({ sheet, rowNumber, name });
    filePhones.set(phone, list);
  };

  const updates: XlsxV2UpdateLine[] = [];
  const creates: XlsxV2CreateLine[] = [];
  const retires: XlsxV2RetireLine[] = [];
  const drivingChanges: XlsxV2DrivingChangeLine[] = [];
  let unchanged = 0;
  const touchedIds = new Set<number>();

  const nextById = new Map(
    existingSnapshot.map((row) => [
      row.id,
      {
        id: row.id,
        name: row.name,
        team: row.team,
        teamOrder: Number(row.teamOrder) || 0,
        emp: empLabel(row.employmentStatus),
        caddyType: row.caddyType ?? null,
        phoneNormalized: row.phoneNormalized ?? null,
        thirdBandSubgroup: (row.thirdBandSubgroup ?? null) as ThirdBandSubgroup | null,
      },
    ])
  );

  for (const row of existingRows) {
    if (row.id == null || row.formula) continue;
    const cur = lookupExisting(row.id, byId, canReadArchived);
    if (!cur) {
      errors.push(
        issue(
          "unknown_id",
          "기존캐디",
          row.rowNumber,
          row.id,
          row.nameRaw,
          `id ${row.id} 를 DB에서 찾을 수 없습니다.`
        )
      );
      continue;
    }
    if (!occupiesHouseThirdSlot(cur)) {
      errors.push(
        issue(
          "driving_on_existing_sheet",
          "기존캐디",
          row.rowNumber,
          row.id,
          cur.name,
          "드라이빙 캐디는 드라이빙 시트에서만 수정하세요."
        )
      );
      continue;
    }
    pushNameVerification(
      row.nameRaw,
      cur.name,
      "기존캐디",
      row.rowNumber,
      row.id,
      errors,
      warnings
    );

    const nextName = row.nameRaw ? row.nameRaw : cur.name;
    let nextTeam = cur.team;
    if (row.teamRaw) {
      if (!isPrimaryTeam(row.teamRaw)) {
        errors.push(
          issue(
            "invalid_team",
            "기존캐디",
            row.rowNumber,
            row.id,
            nextName,
            `허용되지 않는 조입니다: ${row.teamRaw}`
          )
        );
      } else {
        nextTeam = row.teamRaw;
      }
    }

    let nextOrder = Number(cur.teamOrder) || 0;
    if (row.teamOrderRaw) {
      try {
        const parsed = parseImportTeamOrder(row.teamOrderRaw);
        if (parsed == null) {
          errors.push(
            issue(
              "invalid_team_order",
              "기존캐디",
              row.rowNumber,
              row.id,
              nextName,
              `teamOrder가 올바르지 않습니다: ${row.teamOrderRaw}`
            )
          );
        } else {
          const cap = getConfiguredSlotCapacity(nextTeam);
          if (parsed > cap && parsed !== (Number(cur.teamOrder) || 0)) {
            errors.push(
              issue(
                "team_order_out_of_range",
                "기존캐디",
                row.rowNumber,
                row.id,
                nextName,
                `${nextTeam} 슬롯은 1~${cap}만 가능합니다.`
              )
            );
          } else {
            nextOrder = parsed;
          }
        }
      } catch (e) {
        errors.push(
          issue(
            "invalid_team_order",
            "기존캐디",
            row.rowNumber,
            row.id,
            nextName,
            e instanceof Error ? e.message : "teamOrder가 올바르지 않습니다."
          )
        );
      }
    }

    let nextEmp = empLabel(cur.employmentStatus);
    if (row.employmentRaw) {
      try {
        const parsed = parseImportEmploymentStatus(row.employmentRaw);
        if (parsed === "RETIRED") {
          errors.push(
            issue(
              "retire_use_retire_sheet",
              "기존캐디",
              row.rowNumber,
              row.id,
              nextName,
              "퇴사는 퇴사 시트의 id로만 표시하세요."
            )
          );
        } else if (parsed) {
          nextEmp = parsed;
        }
      } catch (e) {
        errors.push(
          issue(
            "invalid_employment_status",
            "기존캐디",
            row.rowNumber,
            row.id,
            nextName,
            e instanceof Error ? e.message : "재직상태가 올바르지 않습니다."
          )
        );
      }
    }

    let nextPhone = cur.phoneNormalized ?? null;
    const parsedPhone = parsePhoneOptional(
      row.phoneRaw,
      "기존캐디",
      row.rowNumber,
      row.id,
      nextName,
      errors
    );
    if (parsedPhone !== undefined) {
      nextPhone = parsedPhone;
      trackPhone(parsedPhone, "기존캐디", row.rowNumber, nextName);
    }

    let nextSub = (cur.thirdBandSubgroup ?? null) as ThirdBandSubgroup | null;
    if (row.thirdBandRaw) {
      try {
        const requested = parseImportThirdBandSubgroup(row.thirdBandRaw);
        nextSub = resolveThirdBandSubgroup({
          team: nextTeam,
          requested: requested === undefined ? row.thirdBandRaw : requested,
          current: nextSub,
        });
      } catch (e) {
        errors.push(
          issue(
            "invalid_third_band_subgroup",
            "기존캐디",
            row.rowNumber,
            row.id,
            nextName,
            e instanceof ThirdBandSubgroupError || e instanceof Error
              ? e.message
              : "3부구분이 올바르지 않습니다."
          )
        );
      }
    } else if (row.teamRaw && isPrimaryTeam(row.teamRaw)) {
      try {
        nextSub = resolveThirdBandSubgroup({
          team: nextTeam,
          requested: undefined,
          current: nextSub,
        });
      } catch (e) {
        errors.push(
          issue(
            "invalid_third_band_subgroup",
            "기존캐디",
            row.rowNumber,
            row.id,
            nextName,
            e instanceof Error ? e.message : "3부구분이 올바르지 않습니다."
          )
        );
      }
    }

    const fields: XlsxV2FieldDiff[] = [];
    const pushDiff = (
      key: string,
      before: string | null,
      after: string | null
    ) => {
      if (before !== after) fields.push({ key, before, after });
    };
    pushDiff("name", cur.name, nextName);
    pushDiff("team", cur.team, nextTeam);
    pushDiff("teamOrder", String(cur.teamOrder ?? 0), String(nextOrder));
    pushDiff("employmentStatus", empLabel(cur.employmentStatus), nextEmp);
    pushDiff(
      "phone",
      maskKrMobile(cur.phoneNormalized ?? null),
      maskKrMobile(nextPhone)
    );
    pushDiff(
      "thirdBandSubgroup",
      subgroupLabel(cur.thirdBandSubgroup as ThirdBandSubgroup | null),
      subgroupLabel(nextSub)
    );

    touchedIds.add(row.id);
    const state = nextById.get(row.id);
    if (state) {
      state.name = nextName;
      state.team = nextTeam;
      state.teamOrder = nextOrder;
      state.emp = nextEmp;
      state.phoneNormalized = nextPhone;
      state.thirdBandSubgroup = nextSub;
      state.caddyType = resolveCaddyTypeFromTeam(nextTeam);
    }

    if (fields.length === 0) {
      unchanged += 1;
    } else {
      updates.push({
        sheet: "기존캐디",
        rowNumber: row.rowNumber,
        id: row.id,
        name: nextName,
        fields,
      });
    }
  }

  for (const row of newRows) {
    if (row.formula) continue;
    if (!row.nameRaw) {
      errors.push(
        issue(
          "name_required",
          "신규캐디",
          row.rowNumber,
          null,
          "",
          "신규캐디 이름은 필수입니다."
        )
      );
      continue;
    }
    if (isNumericOnlyRosterName(row.nameRaw)) {
      errors.push(
        issue(
          "invalid_name",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          "숫자만 있는 값은 성명이 아닙니다."
        )
      );
      continue;
    }
    if (isNeedsReviewName(row.nameRaw)) {
      errors.push(
        issue(
          "needs_review_name",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          "확인 필요 대상은 신규 생성할 수 없습니다."
        )
      );
    }
    if (!isPrimaryTeam(row.teamRaw)) {
      errors.push(
        issue(
          "invalid_team",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          row.teamRaw
            ? `허용되지 않는 조입니다: ${row.teamRaw}`
            : "신규캐디 조는 필수입니다."
        )
      );
      continue;
    }
    let teamOrder: number | null = null;
    try {
      teamOrder = parseImportTeamOrder(row.teamOrderRaw);
    } catch (e) {
      errors.push(
        issue(
          "invalid_team_order",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          e instanceof Error ? e.message : "teamOrder가 올바르지 않습니다."
        )
      );
      continue;
    }
    if (teamOrder == null) {
      errors.push(
        issue(
          "team_order_required",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          "신규캐디 teamOrder는 필수입니다."
        )
      );
      continue;
    }
    const cap = getConfiguredSlotCapacity(row.teamRaw);
    if (teamOrder > cap) {
      errors.push(
        issue(
          "team_order_out_of_range",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          `${row.teamRaw} 슬롯은 1~${cap}만 가능합니다.`
        )
      );
      continue;
    }
    let employment: EmploymentStatusValue = "ACTIVE";
    if (row.employmentRaw) {
      try {
        const parsed = parseImportEmploymentStatus(row.employmentRaw);
        if (parsed === "RETIRED") {
          errors.push(
            issue(
              "create_retired_forbidden",
              "신규캐디",
              row.rowNumber,
              null,
              row.nameRaw,
              "신규 캐디를 퇴사 상태로 만들 수 없습니다."
            )
          );
          continue;
        }
        if (parsed) employment = parsed;
      } catch (e) {
        errors.push(
          issue(
            "invalid_employment_status",
            "신규캐디",
            row.rowNumber,
            null,
            row.nameRaw,
            e instanceof Error ? e.message : "재직상태가 올바르지 않습니다."
          )
        );
        continue;
      }
    }
    const phone = parsePhoneOptional(
      row.phoneRaw,
      "신규캐디",
      row.rowNumber,
      null,
      row.nameRaw,
      errors
    );
    if (phone) trackPhone(phone, "신규캐디", row.rowNumber, row.nameRaw);

    let subgroup: ThirdBandSubgroup | null = null;
    try {
      const requested = row.thirdBandRaw
        ? parseImportThirdBandSubgroup(row.thirdBandRaw)
        : null;
      subgroup = resolveThirdBandSubgroup({
        team: row.teamRaw,
        requested: row.thirdBandRaw ? requested : null,
        current: null,
      });
    } catch (e) {
      errors.push(
        issue(
          "invalid_third_band_subgroup",
          "신규캐디",
          row.rowNumber,
          null,
          row.nameRaw,
          e instanceof Error ? e.message : "3부구분이 올바르지 않습니다."
        )
      );
      continue;
    }

    creates.push({
      sheet: "신규캐디",
      rowNumber: row.rowNumber,
      name: row.nameRaw,
      team: row.teamRaw,
      teamOrder,
      employmentStatus: employment,
      phone: phone ?? null,
      maskedPhone: maskKrMobile(phone ?? null),
      thirdBandSubgroup: subgroup,
      caddyType: resolveCaddyTypeFromTeam(row.teamRaw),
    });
  }

  for (const row of retireRows) {
    if (row.id == null || row.formula) continue;
    const cur = lookupExisting(row.id, byId, canReadArchived);
    if (!cur) {
      errors.push(
        issue(
          "unknown_id",
          "퇴사",
          row.rowNumber,
          row.id,
          row.nameRaw,
          `id ${row.id} 를 DB에서 찾을 수 없습니다.`
        )
      );
      continue;
    }
    pushNameVerification(
      row.nameRaw,
      cur.name,
      "퇴사",
      row.rowNumber,
      row.id,
      errors,
      warnings
    );
    if (empLabel(cur.employmentStatus) === "RETIRED") {
      warnings.push(
        issue(
          "already_retired",
          "퇴사",
          row.rowNumber,
          row.id,
          cur.name,
          "이미 삭제됨(RETIRED)입니다."
        )
      );
      continue;
    }
    touchedIds.add(row.id);
    const state = nextById.get(row.id);
    if (state) state.emp = "RETIRED";
    retires.push({
      sheet: "퇴사",
      rowNumber: row.rowNumber,
      id: row.id,
      name: cur.name,
      reason: row.reasonRaw,
      currentEmploymentStatus: empLabel(cur.employmentStatus),
    });
  }

  for (const row of drivingRows) {
    if (row.id == null || row.formula) continue;
    const cur = lookupExisting(row.id, byId, canReadArchived);
    if (!cur) {
      errors.push(
        issue(
          "unknown_id",
          "드라이빙",
          row.rowNumber,
          row.id,
          row.nameRaw,
          `id ${row.id} 를 DB에서 찾을 수 없습니다.`
        )
      );
      continue;
    }
    pushNameVerification(
      row.nameRaw,
      cur.name,
      "드라이빙",
      row.rowNumber,
      row.id,
      errors,
      warnings
    );
    const driving = drivingPersistFields();
    const nextName = row.nameRaw ? row.nameRaw : cur.name;
    let nextEmp = empLabel(cur.employmentStatus);
    if (row.employmentRaw) {
      try {
        const parsed = parseImportEmploymentStatus(row.employmentRaw);
        if (parsed === "RETIRED") {
          errors.push(
            issue(
              "retire_use_retire_sheet",
              "드라이빙",
              row.rowNumber,
              row.id,
              nextName,
              "퇴사는 퇴사 시트의 id로만 표시하세요."
            )
          );
        } else if (parsed) {
          nextEmp = parsed;
        }
      } catch (e) {
        errors.push(
          issue(
            "invalid_employment_status",
            "드라이빙",
            row.rowNumber,
            row.id,
            nextName,
            e instanceof Error ? e.message : "재직상태가 올바르지 않습니다."
          )
        );
      }
    }
    let nextPhone = cur.phoneNormalized ?? null;
    const parsedPhone = parsePhoneOptional(
      row.phoneRaw,
      "드라이빙",
      row.rowNumber,
      row.id,
      nextName,
      errors
    );
    if (parsedPhone !== undefined) {
      nextPhone = parsedPhone;
      trackPhone(parsedPhone, "드라이빙", row.rowNumber, nextName);
    }

    const kind = occupiesHouseThirdSlot(cur) ? "convert_to_driving" : "update";
    const fields: XlsxV2FieldDiff[] = [];
    const pushDiff = (key: string, before: string | null, after: string | null) => {
      if (before !== after) fields.push({ key, before, after });
    };
    pushDiff("name", cur.name, nextName);
    pushDiff("team", cur.team, driving.team);
    pushDiff("teamOrder", String(cur.teamOrder ?? 0), String(driving.teamOrder));
    pushDiff("caddyType", String(cur.caddyType ?? ""), driving.caddyType);
    pushDiff("employmentStatus", empLabel(cur.employmentStatus), nextEmp);
    pushDiff(
      "phone",
      maskKrMobile(cur.phoneNormalized ?? null),
      maskKrMobile(nextPhone)
    );

    touchedIds.add(row.id);
    const state = nextById.get(row.id);
    if (state) {
      state.name = nextName;
      state.team = driving.team;
      state.teamOrder = driving.teamOrder;
      state.caddyType = driving.caddyType;
      state.emp = nextEmp;
      state.phoneNormalized = nextPhone;
      state.thirdBandSubgroup = null;
    }
    if (fields.length === 0 && kind === "update") {
      unchanged += 1;
    } else {
      drivingChanges.push({
        sheet: "드라이빙",
        rowNumber: row.rowNumber,
        id: row.id,
        name: nextName,
        kind,
        fields,
      });
    }
  }

  for (const [phone, locs] of filePhones) {
    if (locs.length < 2) continue;
    for (const loc of locs) {
      errors.push(
        issue(
          "duplicate_phone_in_file",
          loc.sheet,
          loc.rowNumber,
          null,
          loc.name,
          `파일 안 휴대폰 중복: ${maskKrMobile(phone)}`
        )
      );
    }
  }

  const claimedPhones = new Map<string, number>();
  for (const row of existingSnapshot) {
    if (row.phoneNormalized) claimedPhones.set(row.phoneNormalized, row.id);
  }
  const checkPhoneOwner = (
    phone: string | null,
    selfId: number | null,
    sheet: XlsxV2PreviewSheet,
    rowNumber: number,
    name: string
  ) => {
    if (!phone) return;
    const owner = claimedPhones.get(phone);
    if (owner != null && owner !== selfId) {
      errors.push(
        issue(
          "duplicate_phone_in_db",
          sheet,
          rowNumber,
          selfId,
          name,
          `다른 캐디가 이미 사용 중인 번호입니다: ${maskKrMobile(phone)}`
        )
      );
    }
  };
  for (const u of updates) {
    const phoneField = u.fields.find((f) => f.key === "phone");
    if (!phoneField) continue;
    const state = nextById.get(u.id);
    checkPhoneOwner(
      state?.phoneNormalized ?? null,
      u.id,
      "기존캐디",
      u.rowNumber,
      u.name
    );
  }
  for (const c of creates) {
    checkPhoneOwner(c.phone, null, "신규캐디", c.rowNumber, c.name);
  }
  for (const d of drivingChanges) {
    const state = nextById.get(d.id);
    const phoneField = d.fields.find((f) => f.key === "phone");
    if (!phoneField) continue;
    checkPhoneOwner(
      state?.phoneNormalized ?? null,
      d.id,
      "드라이빙",
      d.rowNumber,
      d.name
    );
  }

  const projected = [
    ...[...nextById.values()].map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team,
      teamOrder: row.teamOrder,
      emp: row.emp,
      caddyType: row.caddyType,
    })),
    ...creates.map((c, i) => ({
      id: null as number | null,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      emp: c.employmentStatus,
      caddyType: c.caddyType,
      _idx: i,
    })),
  ];
  const conflicts = findSlotHoldingConflicts(
    projected.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      teamOrder: p.teamOrder,
      emp: p.emp,
      caddyType: p.caddyType,
    }))
  );
  for (const conflict of conflicts) {
    errors.push(
      issue(
        "slot_conflict",
        "_workbook",
        0,
        conflict.ids.find((id): id is number => id != null) ?? null,
        conflict.names.join(", "),
        `${conflict.team} ${conflict.teamOrder}번 슬롯이 중복됩니다: ${conflict.names.join(", ")}`
      )
    );
  }

  const omittedExisting = existingSnapshot.filter((row) => {
    if (denyArchivedCaddyRead(row.employmentStatus, canReadArchived)) return false;
    if (!isSlotHoldingStatus(empLabel(row.employmentStatus))) return false;
    return !touchedIds.has(row.id);
  }).length;

  const preview: XlsxV2WorkbookPreview = {
    mode: XLSX_V2_PREVIEW_MODE,
    format: XLSX_V2_PREVIEW_FORMAT,
    creates,
    updates,
    retires,
    drivingChanges,
    warnings,
    errors,
    summary: {
      create: creates.length,
      update: updates.length,
      retire: retires.length,
      drivingChange: drivingChanges.length,
      unchanged,
      warning: warnings.length,
      error: errors.length,
      omittedExisting,
      applyAvailable: false,
      applyBlocked: errors.length > 0,
    },
  };
  return preview;
}

export function assertExistingRowsUnchanged<T>(before: T, after: T): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}
