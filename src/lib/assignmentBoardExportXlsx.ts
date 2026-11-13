/**
 * 배치표 Excel(.xlsx) export.
 * /board·PNG·A4 와 같은 공통 시트 모델(buildBoardSheetModel)만 직렬화한다.
 * 자동배치 / draft overwrite / publish / confirm / 재배치 / SET·CLEAR·RESTORE 호출 금지.
 * DB·Spreadsheet write 없음.
 */

import type { RowInfo, WorkBook, WorkSheet } from "xlsx";
import {
  BOARD_EXPORT_COURSE_LABELS,
  BOARD_EXPORT_SHIFTS,
} from "@/lib/assignmentBoardExport";
import {
  BOARD_SHEET_CLOSED_LABEL,
  BOARD_SHEET_COLS_PER_COURSE,
  BOARD_SHEET_REMARK_LABEL,
  BOARD_SHEET_TITLE,
  boardSheetCourseSummary,
  boardSheetSlotText,
  buildBoardSheetModel,
  type BoardSheetModel,
} from "@/lib/boardSheet";
import {
  BOARD_EMPTY_CELL_MARK,
  BOARD_UNASSIGNED_CELL_LABEL,
} from "@/lib/assignmentBoardTeeSheet";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { AssignmentKind, AutoAssignmentRow } from "@/lib/autoAssignEngine";
import {
  DAILY_SPECIAL_SUPPORT_KIND_BADGES,
  parseSupportKindInput,
  parseSupportWorkPatternInput,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
} from "@/lib/dailySpecialSupport";
import {
  COURSE_CODES,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

export const BOARD_XLSX_TITLE = BOARD_SHEET_TITLE;
export const BOARD_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/**
 * 공통 시트(/board·PNG·A4)와 같은 행·열: No | (코스별 시각, 캐디, 비고) × 베르힐·스카이·오션·레이크.
 * 4행: 코스명(3칸 병합), 5행: 시각/캐디/비고, 6행부터 팀 순번 1..21(+초과분).
 * 비고는 빈 칸이며 저장하지 않는다. 시트 보호를 걸지 않아 사용자가 직접 적을 수 있다.
 */
export const BOARD_XLSX_TABLE_HEADERS = [
  "No",
  ...COURSE_CODES.flatMap((code) => [BOARD_EXPORT_COURSE_LABELS[code], "", ""]),
] as const;
/** AOA 0-index: 제목 · 날짜 · 부 · 요약 · 코스 헤더 · 시각/캐디/비고 헤더 · 데이터 */
export const BOARD_XLSX_INFO_ROW = 3;
export const BOARD_XLSX_HEADER_ROW = 4;
export const BOARD_XLSX_SUBHEADER_ROW = 5;
export const BOARD_XLSX_DATA_START_ROW = 6;
export const BOARD_XLSX_COLUMN_COUNT = 1 + COURSE_CODES.length * BOARD_SHEET_COLS_PER_COURSE;
/** 투근무는 노란 채움 없이 칸 문자열의 [투] 표기로만 구분한다 (흑백·편집 가능). */

const LINKED_KIND_TAG: Partial<Record<AssignmentKind, string>> = {
  oneTwo: "1·2",
  two: "2",
  twoThree: "2·3",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

/** 화면 metadata → 짧은 접미사. SPECIAL_SUPPORT는 V1 예시를 따라 [지원]. */
const SUPPORT_KIND_TAG: Record<DailySpecialSupportKind, string> = {
  CHAGEUN: DAILY_SPECIAL_SUPPORT_KIND_BADGES.CHAGEUN,
  SPECIAL_SUPPORT: "지원",
  OFF_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.OFF_SUPPORT,
  MARSHAL_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.MARSHAL_SUPPORT,
  LEADER_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.LEADER_SUPPORT,
  FIFTY_FOUR_SUPPORT: DAILY_SPECIAL_SUPPORT_KIND_BADGES.FIFTY_FOUR_SUPPORT,
};

const SUPPORT_PATTERN_TAG: Partial<Record<DailySpecialSupportWorkPattern, string>> =
  {
    ONE_TWO: "1·2",
    FIFTY_FOUR: "54",
  };

export function boardExportXlsxFilename(date: string): string {
  return `VERTHILL_배치표_${date}.xlsx`;
}

/** Client Excel 버튼 클릭 전에만 로드. 서버 Sheet fetch 경로와 분리. */
export function loadBoardExportXlsx() {
  return import("xlsx");
}

/** 서버 응답용. 클라이언트 <a download>와 같은 파일명을 RFC5987로 인코딩한다. */
export function boardExportXlsxContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function boardExcelAssignmentTags(row: AutoAssignmentRow): string[] {
  const tags: string[] = [];
  const linked = LINKED_KIND_TAG[row.kind];
  if (linked) tags.push(linked);

  const rawKind = row.supportKind || row.caddy?.supportKind;
  const rawPattern = row.supportWorkPattern || row.caddy?.supportWorkPattern;
  const parsedKind = parseSupportKindInput(rawKind);
  const parsedPattern = parseSupportWorkPatternInput(rawPattern);

  if (row.kind === "specialSupport") {
    tags.push(parsedKind ? SUPPORT_KIND_TAG[parsedKind] : "지원");
  } else if (parsedKind && parsedKind !== "SPECIAL_SUPPORT") {
    tags.push(SUPPORT_KIND_TAG[parsedKind]);
  }

  if (parsedPattern) {
    const pat = SUPPORT_PATTERN_TAG[parsedPattern];
    if (pat) tags.push(pat);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    unique.push(tag);
  }
  return unique;
}

function isVacantCaddy(row: AutoAssignmentRow): boolean {
  const caddy = row.caddy;
  if (!caddy) return true;
  if (!Number.isInteger(caddy.id) || caddy.id <= 0) return true;
  return String(caddy.name || "").trim() === "";
}

export function boardExcelAssignmentText(row: AutoAssignmentRow): string {
  if (isVacantCaddy(row)) return "";
  const name = String(row.caddy?.name ?? "").trim();
  if (!name) return "";
  const tags = boardExcelAssignmentTags(row);
  if (tags.length === 0) return name;
  return `${name} [${tags.join("·")}]`;
}

export function boardExcelCellText(rows: readonly AutoAssignmentRow[]): string {
  return rows
    .map((row) => boardExcelAssignmentText(row))
    .filter((text) => text !== "")
    .join("\n");
}

/** 코스 요약/스페어 한 줄 (A4·PNG 상단 줄과 같은 정보) */
export function boardSheetInfoLine(model: BoardSheetModel): string {
  const parts = [
    model.weekday ? `요일: ${model.weekday}` : null,
    `스페어1: ${model.spare.spare1Label || "-"}`,
    `스페어2: ${model.spare.spare2Label || "-"}`,
    `전체 배정 ${model.totals.assigned} · 미배치 ${model.totals.unassigned}`,
    ...model.courses.map((c) => `${c.label} ${boardSheetCourseSummary(c)}`),
    model.overflowCourses.length ? `21팀 초과 ${model.rowCount}행(잘림 없음)` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function boardSheetToAoa(model: BoardSheetModel): unknown[][] {
  const aoa: unknown[][] = [
    [BOARD_XLSX_TITLE],
    [`날짜: ${model.date}`],
    [`부: ${model.shift}`],
    [boardSheetInfoLine(model)],
    [...BOARD_XLSX_TABLE_HEADERS],
    [
      "",
      ...model.courses.flatMap((c) =>
        c.open
          ? ["시각", "캐디", BOARD_SHEET_REMARK_LABEL]
          : [BOARD_SHEET_CLOSED_LABEL, BOARD_SHEET_CLOSED_LABEL, BOARD_SHEET_CLOSED_LABEL]
      ),
    ],
  ];
  for (let i = 0; i < model.rowCount; i++) {
    const line: unknown[] = [i + 1];
    for (const course of model.courses) {
      const slot = course.open ? course.slots[i] : undefined;
      if (!slot) {
        line.push("", "", "");
        continue;
      }
      line.push(
        slot.teeTime,
        slot.state === "empty" ? BOARD_EMPTY_CELL_MARK : boardSheetSlotText(slot, model.includeTeamName),
        "" // 비고: 빈 칸, 저장 없음. 사용자가 엑셀에서 직접 작성.
      );
    }
    aoa.push(line);
  }
  return aoa;
}

/** 엑셀 1-based 열 글자 (A, B, …, Z, AA). 이 시트는 13열이라 Z 안쪽. */
function xlsxColLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 투근무 캐디 칸 주소 (스타일 주입용). A1 형식. */
export function boardSheetTwoWorkCaddyRefs(model: BoardSheetModel): string[] {
  const refs: string[] = [];
  for (let i = 0; i < model.rowCount; i++) {
    model.courses.forEach((course, k) => {
      const slot = course.open ? course.slots[i] : undefined;
      if (!slot) return;
      if (!slot.caddies.some((c) => c.twoWork)) return;
      const col = 1 + k * BOARD_SHEET_COLS_PER_COURSE + 1; // 캐디 열
      const row = BOARD_XLSX_DATA_START_ROW + i + 1; // 1-based
      refs.push(`${xlsxColLetter(col)}${row}`);
    });
  }
  return refs;
}

function applySheetLayout(ws: WorkSheet, dataRowCount: number) {
  // A4 가로 시트 비율: No 좁게, 시각 좁게, 캐디, 비고(사용자가 적을 자리)
  ws["!cols"] = [
    { wch: 4 },
    ...COURSE_CODES.flatMap(() => [{ wch: 7 }, { wch: 18 }, { wch: 12 }]),
  ];
  const rows: RowInfo[] = [
    { hpt: 22 },
    { hpt: 16 },
    { hpt: 16 },
    { hpt: 16 },
    { hpt: 20 },
    { hpt: 14 },
  ];
  for (let i = 0; i < dataRowCount; i++) {
    rows.push({ hpt: 21 });
  }
  ws["!rows"] = rows;
  const last = BOARD_XLSX_COLUMN_COUNT - 1;
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: last } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: last } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: last } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: last } },
    // "No" 헤더 2행 병합 + 코스명 3칸 병합
    { s: { r: BOARD_XLSX_HEADER_ROW, c: 0 }, e: { r: BOARD_XLSX_SUBHEADER_ROW, c: 0 } },
    ...COURSE_CODES.map((_, k) => ({
      s: { r: BOARD_XLSX_HEADER_ROW, c: 1 + k * BOARD_SHEET_COLS_PER_COURSE },
      e: { r: BOARD_XLSX_HEADER_ROW, c: 3 + k * BOARD_SHEET_COLS_PER_COURSE },
    })),
  ];
  ws["!margins"] = {
    left: 0.25,
    right: 0.25,
    top: 0.35,
    bottom: 0.35,
    header: 0.2,
    footer: 0.2,
  };
  delete ws["!protect"];
}

export async function buildBoardExportWorkbook(
  draft: AssignmentDraft
): Promise<WorkBook> {
  const XLSX = await loadBoardExportXlsx();
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: BOARD_XLSX_TITLE,
    Subject: `날짜: ${draft.date}`,
  };
  for (const shift of BOARD_EXPORT_SHIFTS) {
    // /board·PNG·A4 와 같은 공통 시트 모델 (예약자명 제외는 기존 엑셀 정책 그대로)
    const model = buildBoardSheetModel(draft, shift);
    const aoa = boardSheetToAoa(model);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    applySheetLayout(ws, model.rowCount);
    XLSX.utils.book_append_sheet(wb, ws, shift);
  }
  // 인쇄 시 머리글 6행(제목~시각/캐디)을 매 쪽 반복
  wb.Workbook = {
    Names: BOARD_EXPORT_SHIFTS.map((shift, i) => ({
      Name: "_xlnm.Print_Titles",
      Sheet: i,
      Ref: `'${shift}'!$1:$${BOARD_XLSX_DATA_START_ROW}`,
    })),
  };
  return wb;
}

/**
 * SheetJS 무료판이 쓰지 않는 인쇄 설정을 시트 XML 에 추가한다 (셀 값·편집 가능성은 그대로).
 *  - A4 가로, 폭 1쪽 맞춤 (공통 시트 A4 인쇄와 같은 방향)
 *  - 머리글 6행 고정 (스크롤해도 코스/시각/캐디 보임)
 * 실패하면 원본 파일을 그대로 쓴다 (기능 영향 없음).
 */
export function applyBoardXlsxPrintSetup(
  XLSX: typeof import("xlsx"),
  bytes: Uint8Array
): Uint8Array {
  try {
    const mod = XLSX as unknown as { CFB?: CfbApi; default?: { CFB?: CfbApi } };
    const CFB = mod.CFB ?? mod.default?.CFB;
    if (!CFB) return bytes;
    const zip = CFB.read(bytes, { type: "array" });
    const dec = new TextDecoder("utf-8");
    const sheetXml = new Map<number, string>();
    const enc = new TextEncoder();
    let changed = 0;
    let stylesOk = false;
    zip.FullPaths.forEach((path, i) => {
      if (/xl\/styles\.xml$/.test(path)) {
        const entry = zip.FileIndex[i];
        if (!entry?.content) return;
        const xml = injectBoardXlsxStyles(dec.decode(entry.content as Uint8Array));
        if (xml) {
          entry.content = enc.encode(xml);
          entry.size = (entry.content as Uint8Array).length;
          stylesOk = true;
        }
        return;
      }
      if (!/xl\/worksheets\/sheet\d+\.xml$/.test(path)) return;
      const entry = zip.FileIndex[i];
      if (!entry?.content) return;
      let xml = dec.decode(entry.content as Uint8Array);
      if (xml.includes("<pageSetup")) return;
      xml = xml.replace(
        '<sheetView workbookViewId="0"/>',
        `<sheetView workbookViewId="0"><pane ySplit="${BOARD_XLSX_DATA_START_ROW}" topLeftCell="A${BOARD_XLSX_DATA_START_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      );
      if (!xml.includes("<sheetPr")) {
        xml = xml.replace(/(<worksheet[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
      }
      xml = xml.replace(
        /(<pageMargins[^>]*\/>)/,
        '$1<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
      );
      sheetXml.set(i, xml);
      changed += 1;
    });
    if (!changed) return bytes;
    // 칸 서식(테두리·굵게·머리글 음영·초과 표시)은 styles.xml 주입이 성공했을 때만 적용
    for (const [i, xml] of sheetXml) {
      const entry = zip.FileIndex[i];
      entry.content = enc.encode(stylesOk ? styleBoardSheetCells(xml) : xml);
      entry.size = (entry.content as Uint8Array).length;
    }
    return toUint8Array(CFB.write(zip, { fileType: "zip", type: "array", compression: true }));
  } catch {
    return bytes;
  }
}

/** 공통 시트 서식 인덱스 (styles.xml cellXfs 뒤에 추가되는 순서, 0은 기본) */
const XF = { title: 1, info: 2, head: 3, no: 4, time: 5, caddy: 6, remark: 7, overflowNo: 8 } as const;

function injectBoardXlsxStyles(xml: string): string | null {
  const fonts = /<fonts count="(\d+)">([\s\S]*?)<\/fonts>/.exec(xml);
  const fills = /<fills count="(\d+)">([\s\S]*?)<\/fills>/.exec(xml);
  const borders = /<borders count="(\d+)">([\s\S]*?)<\/borders>/.exec(xml);
  const xfs = /<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!fonts || !fills || !borders || !xfs || xfs[1] !== "1") return null;
  const f0 = Number(fonts[1]);
  const fl0 = Number(fills[1]);
  const b0 = Number(borders[1]);
  const fontBold = f0;
  const fontTitle = f0 + 1;
  const fontSmall = f0 + 2;
  const fillHead = fl0;
  const fillOver = fl0 + 1;
  const borderThin = b0;
  const thin = '<left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/>';
  const center = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
  const left = '<alignment vertical="center" wrapText="1"/>';
  // 비고: 잠금 해제 (시트 보호를 걸지 않더라도 locked=0 명시)
  const unlocked = '<protection locked="0"/>';
  const fontOver = f0 + 3;
  const newXfs = [
    `<xf numFmtId="0" fontId="${fontTitle}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`,
    `<xf numFmtId="0" fontId="${fontSmall}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`,
    `<xf numFmtId="0" fontId="${fontBold}" fillId="${fillHead}" borderId="${borderThin}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${center}</xf>`,
    `<xf numFmtId="0" fontId="${fontSmall}" fillId="0" borderId="${borderThin}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${center}</xf>`,
    `<xf numFmtId="0" fontId="${fontBold}" fillId="0" borderId="${borderThin}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${center}</xf>`,
    `<xf numFmtId="0" fontId="${fontBold}" fillId="0" borderId="${borderThin}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${left}</xf>`,
    `<xf numFmtId="0" fontId="${fontSmall}" fillId="0" borderId="${borderThin}" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1" applyProtection="1">${left}${unlocked}</xf>`,
    `<xf numFmtId="0" fontId="${fontOver}" fillId="${fillOver}" borderId="${borderThin}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${center}</xf>`,
  ];
  return xml
    .replace(fonts[0], `<fonts count="${f0 + 4}">${fonts[2]}<font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="16"/><name val="Calibri"/><family val="2"/></font><font><sz val="10"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF991B1B"/><name val="Calibri"/><family val="2"/></font></fonts>`)
    .replace(fills[0], `<fills count="${fl0 + 2}">${fills[2]}<fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4F4F5"/><bgColor indexed="64"/></patternFill></fill></fills>`)
    .replace(borders[0], `<borders count="${b0 + 1}">${borders[2]}<border>${thin}</border></borders>`)
    .replace(xfs[0], `<cellXfs count="${1 + newXfs.length}">${xfs[2]}${newXfs.join("")}</cellXfs>`);
}

function styleBoardSheetCells(xml: string): string {
  const head1 = BOARD_XLSX_HEADER_ROW + 1;
  const head2 = BOARD_XLSX_SUBHEADER_ROW + 1;
  const data = BOARD_XLSX_DATA_START_ROW + 1;
  const overflowFrom = data + 21; // 22번째 데이터 행부터 (기본 21행 다음)
  return xml.replace(/<c r="([A-Z]+)(\d+)"(?![^>]*\ss=)/g, (m, col: string, rowStr: string) => {
    const r = Number(rowStr);
    let xf: number;
    if (r === 1) xf = XF.title;
    else if (r < head1) xf = XF.info;
    else if (r <= head2) xf = XF.head;
    else if (r >= data) {
      const c = col.length === 1 ? col.charCodeAt(0) - 65 : 26 * (col.charCodeAt(0) - 64) + (col.charCodeAt(1) - 65);
      if (c === 0) xf = r >= overflowFrom ? XF.overflowNo : XF.no;
      else {
        const kind = (c - 1) % BOARD_SHEET_COLS_PER_COURSE;
        xf = kind === 0 ? XF.time : kind === 1 ? XF.caddy : XF.remark;
      }
    } else return m;
    return `<c r="${col}${rowStr}" s="${xf}"`;
  });
}

type CfbApi = {
  read: (data: Uint8Array, opts: { type: string }) => {
    FullPaths: string[];
    FileIndex: Array<{ content?: unknown; size?: number }>;
  };
  write: (cfb: unknown, opts: { fileType: string; type: string; compression?: boolean }) => unknown;
};

function toUint8Array(out: unknown): Uint8Array {
  if (out instanceof Uint8Array) return out;
  if (typeof ArrayBuffer !== "undefined" && out instanceof ArrayBuffer) {
    return new Uint8Array(out);
  }
  if (Array.isArray(out)) return Uint8Array.from(out as number[]);
  if (
    typeof Buffer !== "undefined" &&
    typeof Buffer.isBuffer === "function" &&
    Buffer.isBuffer(out)
  ) {
    return new Uint8Array(out);
  }
  throw new Error("xlsx 버퍼를 만들지 못했습니다.");
}

export async function writeBoardExportXlsxBytes(
  draft: AssignmentDraft
): Promise<Uint8Array> {
  const XLSX = await loadBoardExportXlsx();
  const wb = await buildBoardExportWorkbook(draft);
  const out = XLSX.write(wb, {
    bookType: "xlsx",
    type: "array",
    compression: true,
    cellDates: false,
  });
  return applyBoardXlsxPrintSetup(XLSX, toUint8Array(out));
}

export type ParsedBoardExcelRow = {
  teeTime: string;
  values: Record<CourseCode, string>;
};

export type ParsedBoardExcelSheet = {
  name: string;
  title: string;
  dateLine: string;
  shiftLine: string;
  headers: string[];
  rows: ParsedBoardExcelRow[];
};

function cellString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export async function parseBoardExportWorkbook(
  data: Uint8Array | ArrayBuffer | Buffer
): Promise<ParsedBoardExcelSheet[]> {
  const XLSX = await loadBoardExportXlsx();
  const buf =
    data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(new Uint8Array(data as ArrayBuffer));
  const wb = XLSX.read(buf, { type: "buffer", raw: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    const title = cellString(aoa[0]?.[0]);
    const dateLine = cellString(aoa[1]?.[0]);
    const shiftLine = cellString(aoa[2]?.[0]);
    const headers = (aoa[BOARD_XLSX_HEADER_ROW] || []).map((v) => cellString(v));
    // 코스별 (시각, 캐디) 열을 시각 기준 행으로 다시 모은다 (검증·재가져오기용)
    const byTime = new Map<string, ParsedBoardExcelRow>();
    for (let i = BOARD_XLSX_DATA_START_ROW; i < aoa.length; i++) {
      const line = aoa[i] || [];
      COURSE_CODES.forEach((code, k) => {
        const teeTime = cellString(line[1 + k * BOARD_SHEET_COLS_PER_COURSE]).trim();
        if (!teeTime) return;
        let row = byTime.get(teeTime);
        if (!row) {
          row = { teeTime, values: Object.fromEntries(COURSE_CODES.map((c) => [c, ""])) as Record<CourseCode, string> };
          byTime.set(teeTime, row);
        }
        row.values[code] = cellString(line[2 + k * BOARD_SHEET_COLS_PER_COURSE]);
      });
    }
    const rows = [...byTime.values()].sort((x, y) => x.teeTime.localeCompare(y.teeTime));
    return { name, title, dateLine, shiftLine, headers, rows };
  });
}

export function countAssignedExcelCells(sheets: ParsedBoardExcelSheet[]): {
  total: number;
  byShift: Record<ShiftPart, number>;
} {
  const byShift = { "1부": 0, "2부": 0, "3부": 0 } as Record<ShiftPart, number>;
  let total = 0;
  for (const sheet of sheets) {
    const shift = sheet.name as ShiftPart;
    let n = 0;
    for (const row of sheet.rows) {
      for (const code of COURSE_CODES) {
        const text = String(row.values[code] || "").trim();
        if (
          text !== "" &&
          text !== BOARD_EMPTY_CELL_MARK &&
          text !== BOARD_UNASSIGNED_CELL_LABEL &&
          text !== "-"
        ) {
          n += 1;
        }
      }
    }
    if (shift in byShift) byShift[shift] = n;
    total += n;
  }
  return { total, byShift };
}

export function downloadBoardXlsxBytes(
  bytes: Uint8Array,
  filename: string,
  opts?: { revokeMs?: number }
) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: BOARD_XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), opts?.revokeMs ?? 8000);
}
