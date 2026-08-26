/** Shared read-only board styles (subset of /manage/assignments ops-board). */
export const publishedBoardCss = `
  .pub-board-root {
    width: 100%;
    display: grid;
    gap: 8px;
  }
  .ops-board-head-bar {
    width: 100%;
    border: 1px solid #e2e8f0;
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    overflow: hidden;
    background: #0f172a;
  }
  .ops-board-wrap {
    width: 100%;
    overflow-x: clip;
  }
  .ops-board-wrap.has-sticky-head {
    margin-top: 0;
  }
  .ops-board {
    width: 100%;
    display: grid;
    gap: 0;
    border: 1px solid #e2e8f0;
    border-radius: 0 0 8px 8px;
    overflow: hidden;
    background: #fff;
  }
  .ops-board-head,
  .ops-board-row {
    display: grid;
    grid-template-columns: 40px repeat(4, minmax(0, 1fr));
    width: 100%;
  }
  .ops-board-head {
    position: relative;
    background: #0f172a;
    color: #fff;
  }
  .ops-board-head > div {
    padding: 6px 2px;
    text-align: center;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .ops-board-head .bh-course.closed {
    color: #94a3b8;
    text-decoration: line-through;
  }
  .ops-board-block + .ops-board-block {
    border-top: 1px solid #e2e8f0;
  }
  .ops-board-row > .bc-time {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.68rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: #334155;
    background: #f8fafc;
    border-right: 1px solid #e2e8f0;
    padding: 4px 1px;
    min-height: 36px;
  }
  .bc-cell {
    min-width: 0;
    min-height: 36px;
    padding: 4px 2px;
    border-right: 1px solid #f1f5f9;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    font-size: 0.72rem;
    line-height: 1.15;
    background: #fff;
  }
  .ops-board-row > .bc-cell:last-child { border-right: 0; }
  .bc-cell.empty {
    color: #cbd5e1;
    font-weight: 600;
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
    gap: 4px;
    padding: 3px 1px;
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
    gap: 1px;
    width: 100%;
    min-width: 0;
  }
  .bc-team,
  .bc-caddy {
    width: 100%;
    padding: 1px 2px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-height: 22px;
  }
  .bc-team-name {
    font-size: 0.58rem;
    font-weight: 700;
    color: #475569;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lock-chip {
    font-size: 0.58rem;
    padding: 1px 5px;
    min-height: 18px;
    line-height: 1.1;
    border-radius: 999px;
    background: #e2e8f0;
    color: #334155;
    font-weight: 800;
  }
  .bc-name {
    font-weight: 800;
    font-size: 0.78rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #0f172a;
  }
  .bc-affil {
    font-size: 0.55rem;
    font-weight: 700;
    color: #64748b;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.1;
  }
  .bc-marks {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    max-width: 100%;
  }
  .bc-badge {
    display: inline-block;
    font-size: 0.55rem;
    font-weight: 800;
    line-height: 1.15;
    padding: 1px 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .bc-badge.two { color: #334155; background: #e2e8f0; }
  .bc-badge.call { color: #7c5a1e; background: #f4ead6; }
  .bc-badge.limo {
    color: #9a3412;
    background: #fb923c;
    box-shadow: 0 0 0 1px #c2410c;
    font-size: 0.6rem;
  }
  .bc-badge.drive { color: #fff; background: #7c3aed; }
  .bc-special {
    font-size: 0.58rem;
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
    .ops-board-head,
    .ops-board-row {
      grid-template-columns: 32px repeat(4, minmax(0, 1fr));
    }
    .bc-name { font-size: 0.72rem; }
    .bc-team-name { font-size: 0.52rem; }
  }
`;
