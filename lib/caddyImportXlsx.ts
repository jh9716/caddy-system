/**
 * 운영 명단 XLSX/XLS 파서
 *
 * 레이아웃 가정:
 * - 가로로 1조~12조 제목
 * - 각 조 아래(또는 옆)에 카트 / 성명 열 반복
 * - 카트번호가 비어 있어도 성명만 있으면 포함
 * - 카트번호·셀 색(고정카트)는 저장하지 않음
 * - 주중반/주말반/드라이빙은 조 라벨로 읽어 명단에서 누락하지 않음 (DB 타입 변경은 별도)
 */

import * as XLSX from "xlsx";
import type { ImportRow } from "./caddyImport";

const TEAM_RE = /^([1-9]|1[0-2])\s*조$/;
const EXTRA_TEAM_LABELS = new Set(["주중반", "주말반", "드라이빙"]);
const NAME_HEADERS = new Set(["성명", "이름", "name"]);
const CART_HEADERS = new Set(["카트", "카트번호", "cart"]);
const SKIP_NAME_VALUES = new Set([
  "",
  "성명",
  "이름",
  "name",
  "카트",
  "카트번호",
  "cart",
  "비고",
  "주중반",
  "주말반",
  "드라이빙",
]);

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    // 엑셀 숫자 카트번호 등은 문자열화하되 이름 파싱에는 거의 안 씀
    return String(value);
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function isTeamLabel(value: string): string | null {
  const compact = value.replace(/\s+/g, "");
  const m = compact.match(/^([1-9]|1[0-2])조$/);
  if (m) return `${Number(m[1])}조`;
  if (EXTRA_TEAM_LABELS.has(compact)) return compact;
  return null;
}

function sheetToMatrix(sheet: XLSX.WorkSheet): string[][] {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const matrix: string[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      row.push(cellText(cell?.v));
    }
    matrix.push(row);
  }
  return matrix;
}

type TeamBlock = {
  team: string;
  headerRow: number;
  headerCol: number;
  nameCol: number;
  dataStartRow: number;
};

function resolveNameCol(matrix: string[][], headerRow: number, headerCol: number): {
  nameCol: number;
  dataStartRow: number;
} {
  // 제목 행~+3행에서 성명/이름 헤더 탐색 (같은 열 또는 +1열)
  for (let r = headerRow; r <= Math.min(headerRow + 3, matrix.length - 1); r++) {
    for (const c of [headerCol, headerCol + 1, headerCol + 2]) {
      const v = cellText(matrix[r]?.[c]).replace(/\s+/g, "");
      const lower = v.toLowerCase();
      if (NAME_HEADERS.has(v) || NAME_HEADERS.has(lower)) {
        return { nameCol: c, dataStartRow: r + 1 };
      }
    }
  }

  const below = cellText(matrix[headerRow + 1]?.[headerCol]).replace(/\s+/g, "");
  const belowRight = cellText(matrix[headerRow + 1]?.[headerCol + 1]).replace(/\s+/g, "");
  if (CART_HEADERS.has(below) && (NAME_HEADERS.has(belowRight) || belowRight === "")) {
    // 카트 | 성명 패턴 (성명 헤더가 비어 있어도 +1을 성명으로 간주하는 경우는 헤더가 있을 때만)
    if (NAME_HEADERS.has(belowRight)) {
      return { nameCol: headerCol + 1, dataStartRow: headerRow + 2 };
    }
  }
  if (CART_HEADERS.has(below)) {
    return { nameCol: headerCol + 1, dataStartRow: headerRow + 2 };
  }
  if (NAME_HEADERS.has(below)) {
    return { nameCol: headerCol, dataStartRow: headerRow + 2 };
  }

  // 폴백: 조 제목 바로 아래부터, 제목 열+1을 성명으로 가정(카트/성명 쌍)
  return { nameCol: headerCol + 1, dataStartRow: headerRow + 1 };
}

function findTeamBlocks(matrix: string[][]): TeamBlock[] {
  const found: TeamBlock[] = [];
  const scanRows = Math.min(matrix.length, 40);

  for (let r = 0; r < scanRows; r++) {
    const row = matrix[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const team = isTeamLabel(cellText(row[c]));
      if (!team) continue;
      const { nameCol, dataStartRow } = resolveNameCol(matrix, r, c);
      found.push({
        team,
        headerRow: r,
        headerCol: c,
        nameCol,
        dataStartRow,
      });
    }
  }

  // 같은 조가 여러 번이면 왼쪽(먼저 발견) 우선
  const byTeam = new Map<string, TeamBlock>();
  for (const b of found) {
    if (!byTeam.has(b.team)) byTeam.set(b.team, b);
  }

  const teamOrder = (team: string) => {
    const n = Number(team.replace("조", ""));
    if (Number.isFinite(n)) return n;
    if (team === "주중반") return 100;
    if (team === "주말반") return 101;
    if (team === "드라이빙") return 102;
    return 999;
  };

  return [...byTeam.values()].sort((a, b) => teamOrder(a.team) - teamOrder(b.team));
}

function looksLikeHeaderName(value: string): boolean {
  const v = value.replace(/\s+/g, "");
  return (
    SKIP_NAME_VALUES.has(v) ||
    SKIP_NAME_VALUES.has(v.toLowerCase()) ||
    TEAM_RE.test(v) ||
    EXTRA_TEAM_LABELS.has(v)
  );
}

/**
 * 2D 문자열 매트릭스에서 1~12조 성명 추출 (카트 무시, DB 저장 없음)
 */
export function parseTeamNameMatrix(matrix: string[][]): ImportRow[] {
  const blocks = findTeamBlocks(matrix);
  if (blocks.length === 0) {
    throw new Error(
      "XLSX에서 1조~12조 제목을 찾지 못했습니다. 조 제목과 성명 열이 있는 시트를 업로드하세요."
    );
  }

  const rows: ImportRow[] = [];
  let seq = 0;

  for (const block of blocks) {
    let emptyStreak = 0;
    for (let r = block.dataStartRow; r < matrix.length; r++) {
      const name = cellText(matrix[r]?.[block.nameCol]);
      if (!name || looksLikeHeaderName(name)) {
        emptyStreak++;
        // 조 블록 사이 빈 줄 허용, 연속 8칸 비면 해당 조 종료
        if (emptyStreak >= 8) break;
        continue;
      }
      emptyStreak = 0;
      seq++;
      // 카트 열 값은 raw에만 참고용으로 넣고 apply/DB에는 쓰지 않음
      const cartGuess = cellText(matrix[r]?.[block.nameCol - 1]);
      rows.push({
        name,
        team: block.team,
        rowNumber: seq,
        raw: {
          team: block.team,
          name,
          cart: CART_HEADERS.has(cartGuess.replace(/\s+/g, "")) ? "" : cartGuess,
        },
      });
    }
  }

  if (rows.length === 0) {
    throw new Error("XLSX에서 성명 데이터를 읽지 못했습니다.");
  }
  return rows;
}

export function parseXlsxRosterBuffer(buffer: Buffer, filename = "roster.xlsx"): ImportRow[] {
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: false,
    // 색상(고정카트) 무시 — 셀 값만 사용
    cellStyles: false,
  });

  if (!wb.SheetNames.length) {
    throw new Error("XLSX에 시트가 없습니다.");
  }

  // 첫 시트부터 조 제목이 있는 시트를 사용
  let lastError: Error | null = null;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const matrix = sheetToMatrix(sheet);
    try {
      const rows = parseTeamNameMatrix(matrix);
      if (rows.length > 0) return rows;
    } catch (e: any) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw (
    lastError ??
    new Error(`${filename}: 1조~12조 성명 레이아웃을 해석하지 못했습니다.`)
  );
}

/** 테스트용: AOA로 워크북 버퍼 생성 */
export function buildTestRosterXlsxBuffer(aoa: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "명단");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
