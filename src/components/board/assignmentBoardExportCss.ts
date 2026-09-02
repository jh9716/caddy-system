/** 게시용 배치표 PNG 전용 스타일. 관리 조작 UI 없음. */

export const assignmentBoardExportCss = `
.bx-root {
  width: 720px;
  box-sizing: border-box;
  background: #fff;
  color: #0f172a;
  font-family: "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
  padding: 20px 16px 16px;
}
.bx-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-bottom: 14px;
}
.bx-brand {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #0f172a;
}
.bx-date {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #334155;
  font-variant-numeric: tabular-nums;
}
.bx-shift {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  color: #0f172a;
}
.bx-spares {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.bx-spare {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  background: #f8fafc;
}
.bx-spare-lbl {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: #64748b;
  margin-bottom: 2px;
}
.bx-spare-val {
  font-size: 15px;
  font-weight: 800;
  color: #0f172a;
}
.bx-spare-val.muted {
  color: #94a3b8;
  font-weight: 600;
}
.bx-board-head {
  display: grid;
  grid-template-columns: 64px repeat(4, minmax(0, 1fr));
  background: #0f172a;
  color: #fff;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
}
.bx-board-head > div {
  padding: 8px 1px;
  text-align: center;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.bx-board-head .closed {
  color: #94a3b8;
  text-decoration: line-through;
}
.bx-board {
  border: 1px solid #e2e8f0;
  border-top: 0;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
  background: #fff;
}
.bx-row {
  display: grid;
  grid-template-columns: 64px repeat(4, minmax(0, 1fr));
  border-top: 1px solid #e2e8f0;
}
.bx-row:first-child { border-top: 0; }
.bx-time {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: #0f172a;
  background: #f8fafc;
  border-right: 1px solid #e2e8f0;
  min-height: 44px;
  padding: 6px 2px;
}
.bx-cell {
  min-width: 0;
  min-height: 44px;
  padding: 5px 3px;
  border-right: 1px solid #f1f5f9;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: #fff;
}
.bx-row > .bx-cell:last-child { border-right: 0; }
.bx-cell.empty {
  color: #cbd5e1;
  font-size: 16px;
  font-weight: 600;
}
.bx-cell.closed {
  background: repeating-linear-gradient(
    -45deg,
    #f1f5f9,
    #f1f5f9 4px,
    #e2e8f0 4px,
    #e2e8f0 8px
  );
  color: #94a3b8;
  font-size: 12px;
  font-weight: 800;
}
.bx-cell.assigned.special { background: #fffbeb; }
.bx-cell.assigned.two-work {
  background: #f8fafc;
  box-shadow: inset 2px 0 0 #94a3b8;
}
.bx-cell.assigned.chageun {
  background: #fffdf6;
  box-shadow: inset 2px 0 0 #d6b37a;
}
.bx-cell.assigned.two-work.chageun {
  background: #f8fafc;
  box-shadow: inset 2px 0 0 #94a3b8, inset 0 -2px 0 #d6b37a;
}
.bx-cell.assigned.limo { box-shadow: inset 0 0 0 1px #fb923c; }
.bx-cell.assigned.drive { box-shadow: inset 0 0 0 1px #7c3aed; }
.bx-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 1px;
}
.bx-name {
  font-weight: 800;
  font-size: 14px;
  color: #0f172a;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bx-affil {
  font-size: 10px;
  font-weight: 700;
  color: #64748b;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bx-marks {
  display: inline-flex;
  gap: 2px;
  flex-wrap: wrap;
  justify-content: center;
}
.bx-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 800;
  line-height: 1.15;
  padding: 1px 4px;
  border-radius: 4px;
}
.bx-badge.two { color: #334155; background: #e2e8f0; }
.bx-badge.call { color: #7c5a1e; background: #f4ead6; }
.bx-badge.support { color: #1e3a8a; background: #dbeafe; }
.bx-badge.limo { color: #9a3412; background: #fb923c; }
.bx-badge.drive { color: #fff; background: #7c3aed; }
.bx-special { font-size: 10px; font-weight: 800; color: #b45309; }
.bx-empty-board {
  padding: 28px 12px;
  text-align: center;
  color: #94a3b8;
  font-weight: 700;
}
`;
