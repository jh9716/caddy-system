/**
 * 배치표 공통 시트 디자인 토큰 + CSS.
 * /board 화면 · PNG · A4 인쇄가 같은 CSS 를 쓴다. 단위는 mm/pt (A4 가로 인쇄 기준, 화면에서는 96dpi 환산).
 * A4 가로 인쇄 가능 영역 281mm × 193mm (여백 8/8/9mm) 안에 21행이 한 장에 들어가도록 설계.
 */
export const BOARD_SHEET_TOKENS = {
  /** 시트 폭 = A4 가로 297mm - 좌우 여백 16mm */
  sheetWidthMm: 281,
  noColMm: 8,
  timeColMm: 13,
  /** 21행 기준 최소 행 높이 */
  rowHeightMm: 7.3,
  fontNamePt: 11.5,
  fontTimePt: 10.5,
  fontAffilPt: 8,
  fontMarkPt: 7,
  fontHeadPt: 12,
  border: "0.6pt solid #333",
  headBg: "#e5e7eb",
  closedBg: "#d1d5db",
  overflowBg: "#fef3c7",
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
.bs-table thead { display: table-header-group; }
.bs-table tr { break-inside: avoid; page-break-inside: avoid; }
.bs-table th, .bs-table td {
  border: ${T.border};
  padding: 0.6mm 1.1mm;
  vertical-align: middle;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
.bs-cap { border: 0 !important; padding: 0 0 1.6mm !important; text-align: left; font-weight: 400; }
.bs-cap-inner { display: flex; align-items: baseline; gap: 3.5mm; flex-wrap: wrap; }
.bs-title { font-size: 12.5pt; font-weight: 800; letter-spacing: 0.02em; }
.bs-date { font-size: 12.5pt; font-weight: 800; }
.bs-shift { font-size: 14pt; font-weight: 900; padding: 0.2mm 3mm; border: 1.2pt solid #000; border-radius: 1.5mm; }
.bs-spares { display: inline-flex; gap: 3mm; font-size: 9pt; }
.bs-spares b { font-weight: 800; }
.bs-totals { margin-left: auto; font-size: 9pt; }
.bs-flag { font-size: 8.5pt; font-weight: 800; border: 0.8pt solid #000; background: ${T.overflowBg}; padding: 0 1.5mm; }
.bs-course-row th, .bs-sub-row th { background: ${T.headBg}; text-align: center; }
.bs-h-no { font-size: 8pt; }
.bs-h-name { display: block; font-size: ${T.fontHeadPt}pt; font-weight: 900; }
.bs-h-sub { display: block; font-size: 7.5pt; font-weight: 600; color: #222; }
.bs-course-row th.closed, .bs-sub-row th.closed { background: ${T.closedBg}; color: #444; }
.bs-sub-row th { font-size: 7.5pt; font-weight: 700; padding: 0.3mm 1mm; }
.bs-table tbody tr { height: ${T.rowHeightMm}mm; }
.bs-no { text-align: center; font-size: 7.5pt; color: #444; font-weight: 600; background: #f9fafb; }
.bs-time { text-align: center; font-size: ${T.fontTimePt}pt; font-weight: 800; font-variant-numeric: tabular-nums; background: #f3f4f6; white-space: nowrap; }
.bs-cell { text-align: left; }
.bs-time.closed, .bs-cell.closed { background: repeating-linear-gradient(135deg, #f3f4f6 0 2mm, #e5e7eb 2mm 4mm); }
.bs-row-over .bs-no { background: ${T.overflowBg}; color: #000; font-weight: 900; }
.bs-slot { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 1.3mm; row-gap: 0.3mm; }
.bs-slot + .bs-slot { margin-top: 0.5mm; padding-top: 0.5mm; border-top: 0.4pt dashed #777; }
.bs-name { font-size: ${T.fontNamePt}pt; font-weight: 800; white-space: nowrap; }
.bs-affil { font-size: ${T.fontAffilPt}pt; color: #333; white-space: nowrap; }
.bs-marks { display: inline-flex; flex-wrap: nowrap; flex: 0 0 auto; gap: 0.7mm; }
.bs-mark { font-size: ${T.fontMarkPt}pt; font-weight: 700; border: 0.6pt solid #000; border-radius: 1mm; padding: 0 0.7mm; white-space: nowrap; }
.bs-vacant { font-size: 9.5pt; font-weight: 800; border: 0.8pt dashed #000; padding: 0 1.2mm; }
.bs-team { flex-basis: 100%; font-size: 7.5pt; color: #333; }
.bs-foot { margin: 1.2mm 0 0; font-size: 7pt; color: #444; }
`;
