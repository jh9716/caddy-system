/**
 * 배치표 공통 시트 디자인 토큰 + CSS.
 * /board 화면 · PNG · A4 인쇄가 같은 CSS 를 쓴다. 단위는 mm/pt (A4 가로 인쇄 기준, 화면에서는 96dpi 환산).
 * A4 가로 인쇄 가능 영역 281mm × 193mm (여백 8/8/9mm) 안에 21행이 한 장에 들어가도록 설계.
 * 투근무는 색이 아닌 테두리 배지(「투」)로 표시해 흑백 인쇄에서도 구분된다.
 * 21 초과 행은 빨간 글자·테두리로 표시한다.
 */
export const BOARD_SHEET_TOKENS = {
  /** 시트 폭 = A4 가로 297mm - 좌우 여백 16mm */
  sheetWidthMm: 281,
  noColMm: 7,
  timeColMm: 11,
  remarkColMm: 14,
  /** 21행 기준 최소 행 높이 (비고 열·하단 바를 넣어도 1장에 들어가도록 조정) */
  rowHeightMm: 7.0,
  fontNamePt: 11,
  fontTimePt: 10,
  fontAffilPt: 7.5,
  fontMarkPt: 7,
  fontHeadPt: 11,
  border: "0.6pt solid #333",
  headBg: "#e5e7eb",
  closedBg: "#d1d5db",
  footerBg: "#16325C",
  /** 21 초과 행 표시 (빨간 글자·회색 배경, 색만으로 구분하지 않음) */
  overflowFg: "#991B1B",
  overflowBg: "#F4F4F5",
} as const;

const T = BOARD_SHEET_TOKENS;

export const boardSheetCss = `
.bs-sheet {
  font-family: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", sans-serif;
  color: #000;
  width: ${T.sheetWidthMm}mm;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.bs-table { width: 100%; table-layout: fixed; border-collapse: collapse; line-height: 1.15; }
.bs-col-no { width: ${T.noColMm}mm; }
.bs-col-time { width: ${T.timeColMm}mm; }
.bs-col-remark { width: ${T.remarkColMm}mm; }
.bs-table thead { display: table-header-group; }
.bs-table tr { break-inside: avoid; page-break-inside: avoid; }
.bs-table th, .bs-table td {
  border: ${T.border};
  padding: 0.5mm 0.8mm;
  vertical-align: middle;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
.bs-cap { border: 0 !important; padding: 0 0 1.2mm !important; text-align: left; font-weight: 400; }
.bs-cap-inner { display: flex; align-items: baseline; gap: 3mm; flex-wrap: wrap; }
.bs-title { font-size: 12pt; font-weight: 800; letter-spacing: 0.02em; }
.bs-date { font-size: 12pt; font-weight: 800; }
.bs-shift { font-size: 13pt; font-weight: 900; padding: 0.2mm 2.5mm; border: 1.2pt solid #000; border-radius: 1.5mm; }
.bs-flag { font-size: 8pt; font-weight: 800; border: 0.8pt solid ${T.overflowFg}; background: ${T.overflowBg}; color: ${T.overflowFg}; padding: 0 1.5mm; }
.bs-course-row th, .bs-sub-row th { background: ${T.headBg}; text-align: center; }
.bs-h-no { font-size: 8pt; }
.bs-h-name { display: block; font-size: ${T.fontHeadPt}pt; font-weight: 900; }
.bs-h-sub { display: block; font-size: 7pt; font-weight: 600; color: #222; }
.bs-course-row th.closed, .bs-sub-row th.closed { background: ${T.closedBg}; color: #444; }
.bs-sub-row th { font-size: 7.5pt; font-weight: 700; padding: 0.3mm 0.8mm; }
.bs-table tbody tr { height: ${T.rowHeightMm}mm; }
.bs-no { text-align: center; font-size: 7.5pt; color: #444; font-weight: 600; background: #f9fafb; }
.bs-time { text-align: center; font-size: ${T.fontTimePt}pt; font-weight: 800; font-variant-numeric: tabular-nums; background: #f3f4f6; white-space: nowrap; }
.bs-cell { text-align: left; }
.bs-remark { background: #fff; }
.bs-time.closed, .bs-cell.closed, .bs-remark.closed { background: repeating-linear-gradient(135deg, #f3f4f6 0 2mm, #e5e7eb 2mm 4mm); }
.bs-row-over .bs-no { background: ${T.overflowBg}; color: ${T.overflowFg}; font-weight: 900; box-shadow: inset 0 0 0 1pt ${T.overflowFg}; }
/* 21행은 1쪽에 두고, 초과 행(22~)은 다음 쪽에서 머리글과 함께 이어진다. 하단 바도 초과 행 뒤를 따른다. */
.bs-table tbody tr.bs-row-over:nth-child(22) {
  break-before: page;
  page-break-before: always;
}
.bs-slot { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 1.1mm; row-gap: 0.2mm; }
.bs-slot + .bs-slot { margin-top: 0.4mm; padding-top: 0.4mm; border-top: 0.4pt dashed #777; }
.bs-name { font-size: ${T.fontNamePt}pt; font-weight: 800; white-space: nowrap; }
.bs-affil { font-size: ${T.fontAffilPt}pt; color: #333; white-space: nowrap; }
.bs-marks { display: inline-flex; flex-wrap: nowrap; flex: 0 0 auto; gap: 0.6mm; }
/* 흑백 인쇄: 색에 의존하지 않고 검정 테두리+글자로 구분 */
.bs-mark { font-size: ${T.fontMarkPt}pt; font-weight: 700; border: 0.7pt solid #000; border-radius: 1mm; padding: 0 0.6mm; white-space: nowrap; background: #fff; color: #000; }
.bs-mark[data-sheet-mark="투"] { font-weight: 900; border-width: 1.1pt; }
.bs-vacant { font-size: 9pt; font-weight: 800; border: 0.8pt dashed #000; padding: 0 1.1mm; }
.bs-team { flex-basis: 100%; font-size: 7.5pt; color: #333; }
.bs-footer-bar {
  display: flex;
  align-items: center;
  gap: 5mm;
  flex-wrap: wrap;
  margin-top: 1.4mm;
  padding: 1.5mm 3mm;
  background: ${T.footerBg};
  color: #fff;
  font-size: 9.5pt;
  font-weight: 700;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.bs-footer-bar b { font-weight: 900; }
.bs-foot-assigned { margin-left: auto; }
.bs-footer-bar .bs-flag { background: #fff; }
.bs-foot { margin: 1mm 0 0; font-size: 6.5pt; color: #444; }
`;
