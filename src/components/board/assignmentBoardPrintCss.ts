/**
 * A4 가로 인쇄 CSS.
 * - 화면: 종이 모양 미리보기 (.bp-paper)
 * - 인쇄: body.bp-print-open 일 때 인쇄 portal 밖의 모든 UI(메뉴·버튼·사이트 헤더)를 숨긴다.
 */
export const BOARD_PRINT_PORTAL_CLASS = "bp-print-portal";
export const BOARD_PRINT_BODY_CLASS = "bp-print-open";

export const assignmentBoardPrintSheetCss = `
.bp-sheet {
  font-family: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Noto Sans CJK KR", sans-serif;
  color: #000;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.bp-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 10.5pt;
  line-height: 1.2;
}
.bp-col-time { width: 15mm; }
.bp-table thead { display: table-header-group; }
.bp-table tr { break-inside: avoid; page-break-inside: avoid; }
.bp-table th, .bp-table td {
  border: 0.6pt solid #333;
  padding: 1.2mm 1.4mm;
  vertical-align: middle;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
.bp-cap { border: 0 !important; padding: 0 0 2mm !important; text-align: left; font-weight: 400; }
.bp-cap-inner { display: flex; align-items: baseline; gap: 4mm; flex-wrap: wrap; }
.bp-title { font-size: 13pt; font-weight: 800; letter-spacing: 0.02em; }
.bp-date { font-size: 13pt; font-weight: 800; }
.bp-shift {
  font-size: 15pt; font-weight: 900; padding: 0.3mm 3mm;
  border: 1.2pt solid #000; border-radius: 1.5mm;
}
.bp-spares { display: inline-flex; gap: 3mm; font-size: 9.5pt; }
.bp-spares b { font-weight: 800; }
.bp-totals { margin-left: auto; font-size: 9.5pt; }
.bp-head-row th { background: #e5e7eb; text-align: center; }
.bp-h-time { font-size: 10pt; }
.bp-h-name { display: block; font-size: 12.5pt; font-weight: 900; }
.bp-h-sub { display: block; font-size: 8pt; font-weight: 600; color: #222; }
.bp-h-course.closed { background: #d1d5db; color: #444; }
.bp-time { text-align: center; font-size: 11pt; font-weight: 800; background: #f3f4f6; font-variant-numeric: tabular-nums; }
.bp-cell { text-align: left; }
.bp-cell.closed { background: repeating-linear-gradient(135deg, #f3f4f6 0 2mm, #e5e7eb 2mm 4mm); }
.bp-cell.unassigned, .bp-slot-vacant { color: #000; }
.bp-slot { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 1.6mm; row-gap: 0.4mm; }
.bp-slot + .bp-slot { margin-top: 0.8mm; padding-top: 0.8mm; border-top: 0.4pt dashed #777; }
.bp-name { font-size: 12pt; font-weight: 800; white-space: nowrap; }
.bp-affil { font-size: 8.5pt; color: #333; white-space: nowrap; }
.bp-marks { display: inline-flex; flex-wrap: wrap; gap: 0.8mm; }
.bp-mark { font-size: 7.5pt; font-weight: 700; border: 0.6pt solid #000; border-radius: 1mm; padding: 0 0.8mm; white-space: nowrap; }
.bp-vacant { font-size: 10pt; font-weight: 800; border: 0.8pt dashed #000; padding: 0 1.2mm; }
.bp-team { flex-basis: 100%; font-size: 8pt; color: #333; }
.bp-none { text-align: center; padding: 10mm !important; font-size: 13pt; font-weight: 700; }
.bp-foot { margin: 1.5mm 0 0; font-size: 7.5pt; color: #444; }
`;

export const assignmentBoardPrintOverlayCss = `
.bp-print-portal { position: fixed; inset: 0; z-index: 2147483000; background: #475569; overflow: auto; -webkit-overflow-scrolling: touch; }
.bp-toolbar {
  position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 10px 12px; background: #0f172a; color: #fff;
  font-family: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}
.bp-toolbar-title { font-weight: 800; font-size: 0.95rem; margin-right: 4px; }
.bp-shift-tabs { display: inline-flex; background: #1e293b; border-radius: 8px; padding: 2px; }
.bp-shift-tabs button {
  min-height: 34px; min-width: 52px; border: 0; border-radius: 6px; background: transparent;
  color: #cbd5e1; font-weight: 800; font-size: 0.9rem; cursor: pointer;
}
.bp-shift-tabs button[aria-pressed="true"] { background: #fff; color: #0f172a; }
.bp-toolbar label { display: inline-flex; align-items: center; gap: 4px; font-size: 0.82rem; color: #e2e8f0; cursor: pointer; }
.bp-toolbar-end { margin-left: auto; display: inline-flex; gap: 6px; }
.bp-btn {
  min-height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid #64748b;
  background: #1e293b; color: #fff; font-weight: 800; font-size: 0.9rem; cursor: pointer;
}
.bp-btn.primary { background: #f8fafc; color: #0f172a; border-color: #f8fafc; }
.bp-hint { flex-basis: 100%; margin: 0; font-size: 0.75rem; color: #94a3b8; }
.bp-stage { padding: 16px 8px 40px; }
.bp-paper {
  box-sizing: border-box; width: 297mm; min-height: 210mm; margin: 0 auto; padding: 8mm;
  background: #fff; box-shadow: 0 8px 28px rgb(0 0 0 / 35%);
}
@media (max-width: 720px) {
  .bp-toolbar { padding: 8px; gap: 6px; }
  .bp-toolbar-end { margin-left: 0; width: 100%; }
  .bp-toolbar-end .bp-btn { flex: 1; }
  .bp-stage { padding: 10px 4px 32px; }
}
@media print {
  @page { size: A4 landscape; margin: 8mm 8mm 9mm; }
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; }
  body.bp-print-open > *:not(.bp-print-portal) { display: none !important; }
  .bp-print-portal { position: static !important; inset: auto; overflow: visible !important; background: #fff !important; z-index: auto; }
  .bp-toolbar { display: none !important; }
  .bp-stage { padding: 0 !important; }
  .bp-paper { width: auto !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; box-shadow: none !important; zoom: 1 !important; }
}
`;
