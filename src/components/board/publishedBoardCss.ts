/** Shared read-only board styles (subset of /manage/assignments ops-board). */
export const publishedBoardCss = `
  .pub-board-root {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    display: grid;
    gap: 8px;
    --ops-board-line: #cbd5e1;
  }
  .ops-board-wrap {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: clip;
  }
  .ops-board {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    table-layout: fixed;
    border-collapse: collapse;
    border-spacing: 0;
    empty-cells: show;
    border: 1px solid var(--ops-board-line);
    background: #fff;
    box-sizing: border-box;
  }
  .ops-col-time { width: 52px; }
  .ops-col-course { width: calc((100% - 52px) / 4); }
  .ops-board-head th {
    box-sizing: border-box;
    height: 32px;
    padding: 4px 2px;
    background: #0f172a;
    color: #fff;
    border: 1px solid #334155;
    font-size: 0.72rem;
    font-weight: 800;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
  }
  .ops-board-head .bh-course.closed {
    color: #94a3b8;
    text-decoration: line-through;
  }
  .ops-board-row > .bc-time,
  .ops-board-row > .bc-cell {
    box-sizing: border-box;
    height: 64px;
    vertical-align: middle;
    border: 1px solid var(--ops-board-line);
  }
  .ops-board-row > .bc-time {
    width: 52px;
    font-size: 0.68rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: #334155;
    background: #f8fafc;
    text-align: center;
    padding: 2px 1px;
  }
  .bc-cell {
    padding: 2px 3px;
    background: #fff;
    font-size: 0.72rem;
    line-height: 1.15;
    text-align: center;
    overflow: hidden;
  }
  .bc-cell.empty {
    background: #fff;
  }
  .bc-cell.unassigned {
    background: #fff;
  }
  .bc-cell.closed {
    background: repeating-linear-gradient(
      -45deg,
      #f1f5f9,
      #f1f5f9 4px,
      #e2e8f0 4px,
      #e2e8f0 8px
    );
    color: #94a3b8;
  }
  .bc-closed {
    font-size: 0.62rem;
    font-weight: 800;
  }
  .bc-cell.assigned {
    background: #fff;
  }
  .bc-cell.assigned.special { background: #fffbeb; }
  .bc-cell.assigned.two-work {
    background: #f8fafc;
    box-shadow: inset 2px 0 0 #94a3b8;
  }
  .bc-cell.assigned.chageun {
    background: #fffdf6;
    box-shadow: inset 2px 0 0 #d6b37a;
  }
  .bc-cell.assigned.limo { box-shadow: inset 0 -3px 0 #f59e0b; }
  .bc-cell.assigned.drive { box-shadow: inset 3px 0 0 #7c3aed; }
  .bc-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    width: 100%;
    min-width: 0;
  }
  .bc-team,
  .bc-caddy {
    width: 100%;
    min-width: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .bc-team {
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: center;
    overflow: hidden;
    gap: 2px;
    min-height: 14px;
  }
  .bc-team .bc-badge {
    flex: 0 0 auto;
  }
  .bc-team-name,
  .bc-name,
  .bc-affil {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }
  .bc-team-name {
    font-size: 0.55rem;
    font-weight: 700;
    color: #475569;
    flex: 0 1 auto;
    min-width: 0;
    line-height: 1.2;
  }
  .lock-chip {
    font-size: 0.52rem;
    padding: 0 4px;
    min-height: 14px;
    line-height: 1.2;
    border-radius: 999px;
    background: #e2e8f0;
    color: #334155;
    font-weight: 800;
    margin-top: 1px;
  }
  .bc-name {
    font-weight: 800;
    font-size: 0.72rem;
    color: #0f172a;
    line-height: 1.2;
  }
  .bc-affil {
    font-size: 0.52rem;
    font-weight: 700;
    color: #64748b;
    line-height: 1.15;
  }
  .bc-marks {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-wrap: nowrap;
    gap: 2px;
    max-width: 100%;
    overflow: hidden;
    height: 14px;
  }
  .bc-badge {
    display: inline-block;
    font-size: 0.52rem;
    font-weight: 800;
    line-height: 1.15;
    padding: 0 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .bc-badge.two { color: #334155; background: #e2e8f0; }
  .bc-badge.call { color: #7c5a1e; background: #f4ead6; }
  .bc-badge.support { color: #1e3a8a; background: #dbeafe; }
  .bc-badge.support-pat { color: #1e3a8a; background: #eff6ff; }
  .bc-badge.house {
    color: #166534;
    background: #dcfce7;
    box-shadow: 0 0 0 1px #86efac;
  }
  .bc-badge.limo {
    color: #9a3412;
    background: #fb923c;
    box-shadow: 0 0 0 1px #c2410c;
  }
  .bc-badge.drive { color: #fff; background: #7c3aed; }
  .bc-badge.two-three { color: #0f766e; background: #ccfbf1; }
  .bc-special {
    font-size: 0.52rem;
    font-weight: 800;
    color: #b45309;
  }
  .pub-spare {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.78rem;
    color: #334155;
    padding: 8px 4px;
  }
  .pub-spare-label {
    font-weight: 800;
    color: #0f172a;
  }
  .pub-empty-shift {
    padding: 18px 8px;
    text-align: center;
    color: #64748b;
    font-size: 0.85rem;
  }
  @media (max-width: 480px) {
    .ops-board-head th {
      font-size: 0.62rem;
    }
    .bc-name { font-size: 0.68rem; }
    .bc-team-name { font-size: 0.5rem; }
  }
`;
