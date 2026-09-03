/** 게시용 배치표 PNG 전용 스타일. 관리 조작 UI 없음. */

export const assignmentBoardExportCss = `
.bx-root {
  width: 720px;
  box-sizing: border-box;
  background: #fbf7ee;
  color: #1c160c;
  font-family: "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
  padding: 20px 16px 16px;
}
.bx-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 3px solid #8a6d2f;
}
.bx-brand {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: #5c4a1f;
}
.bx-date {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #6b5a32;
  font-variant-numeric: tabular-nums;
}
.bx-shift {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  color: #5c4a1f;
}
.bx-spares {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.bx-spare {
  border: 1.5px solid #c4b48a;
  border-radius: 8px;
  padding: 8px 10px;
  background: #f4ead3;
}
.bx-spare-lbl {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: #7a6840;
  margin-bottom: 2px;
}
.bx-spare-val {
  font-size: 15px;
  font-weight: 800;
  color: #1c160c;
}
.bx-spare-val.muted {
  color: #a89870;
  font-weight: 600;
}
.bx-board-head {
  display: grid;
  grid-template-columns: 68px repeat(4, minmax(0, 1fr));
  background: #3d3420;
  color: #f3e6c0;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
}
.bx-board-head > div {
  padding: 9px 1px;
  text-align: center;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: -0.02em;
}
.bx-board-head .closed {
  color: #b8a97a;
  text-decoration: line-through;
}
.bx-board {
  border: 1.5px solid #8a7a52;
  border-top: 0;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
  background: #fffdf7;
}
.bx-row {
  display: grid;
  grid-template-columns: 68px repeat(4, minmax(0, 1fr));
  border-top: 1.5px solid #b6a57a;
}
.bx-row:first-child { border-top: 0; }
.bx-time {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  color: #1c160c;
  background: #efe4c8;
  border-right: 1.5px solid #b6a57a;
  min-height: 46px;
  padding: 6px 2px;
}
.bx-cell {
  min-width: 0;
  min-height: 46px;
  padding: 5px 3px;
  border-right: 1.5px solid #c9bb93;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: #fffdf7;
}
.bx-row > .bx-cell:last-child { border-right: 0; }
.bx-cell.empty {
  color: #c9bb93;
  font-size: 16px;
  font-weight: 600;
}
.bx-cell.closed {
  background: repeating-linear-gradient(
    -45deg,
    #f4ead3,
    #f4ead3 4px,
    #e8dcb8 4px,
    #e8dcb8 8px
  );
  color: #8a7a52;
  font-size: 12px;
  font-weight: 800;
}
.bx-cell.assigned.special { background: #fff6df; }
.bx-cell.assigned.two-work {
  background: #f7f0de;
  box-shadow: inset 2px 0 0 #8a7a52;
}
.bx-cell.assigned.chageun {
  background: #fff8e6;
  box-shadow: inset 2px 0 0 #c4a35a;
}
.bx-cell.assigned.two-work.chageun {
  background: #f7f0de;
  box-shadow: inset 2px 0 0 #8a7a52, inset 0 -2px 0 #c4a35a;
}
.bx-cell.assigned.limo { box-shadow: inset 0 0 0 1px #c47a32; }
.bx-cell.assigned.drive { box-shadow: inset 0 0 0 1px #6b4f9a; }
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
  color: #1c160c;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bx-affil {
  font-size: 10px;
  font-weight: 700;
  color: #6b5a32;
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
.bx-badge.two { color: #3d3420; background: #e8dcb8; }
.bx-badge.call { color: #7c5a1e; background: #f4ead6; }
.bx-badge.support { color: #1e3a8a; background: #dbeafe; }
.bx-badge.limo { color: #9a3412; background: #fb923c; }
.bx-badge.drive { color: #fff; background: #7c3aed; }
.bx-special { font-size: 10px; font-weight: 800; color: #b45309; }
.bx-empty-board {
  padding: 28px 12px;
  text-align: center;
  color: #a89870;
  font-weight: 700;
}
`;
