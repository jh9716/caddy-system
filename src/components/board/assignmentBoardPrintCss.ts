import { boardSheetCss } from "@/components/board/boardSheetCss";

/**
 * A4 가로 인쇄 CSS.
 * - 화면: 종이 모양 미리보기 (.bp-paper)
 * - 인쇄: body.bp-print-open 일 때 인쇄 portal 밖의 모든 UI(메뉴·버튼·사이트 헤더)를 숨긴다.
 */
export const BOARD_PRINT_PORTAL_CLASS = "bp-print-portal";
export const BOARD_PRINT_BODY_CLASS = "bp-print-open";

/** 인쇄 시트 CSS = 공통 시트 CSS */
export const assignmentBoardPrintSheetCss = boardSheetCss;

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
