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
    height: 40px;
    padding: 3px 2px;
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
  }
  .ops-board-head .bh-course.closed .bh-name {
    text-decoration: line-through;
  }
  .bh-name {
    display: block;
    line-height: 1.2;
  }
  .bh-count {
    display: block;
    font-size: 0.62rem;
    font-weight: 700;
    color: #cbd5e1;
    line-height: 1.2;
    white-space: normal;
  }
  .bh-count.over {
    color: #fca5a5;
  }
  .ops-board-row > .bc-time,
  .ops-board-row > .bc-cell {
    box-sizing: border-box;
    height: auto;
    min-height: 0;
    vertical-align: middle;
    border: 1px solid var(--ops-board-line);
  }
  .ops-board-row > .bc-time {
    width: 52px;
    font-size: 0.8rem;
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
    overflow: visible;
    overflow-wrap: anywhere;
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
  /* 투근무는 이름 배경색을 쓰지 않고 기존 '투' 배지(회색)로만 표시한다. */
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
    flex-wrap: wrap;
    justify-content: center;
    overflow: visible;
    gap: 2px;
    min-height: 0;
  }
  .bc-team .bc-badge {
    flex: 0 0 auto;
  }
  .bc-team-name,
  .bc-name,
  .bc-affil {
    max-width: 100%;
    overflow: visible;
    text-align: center;
  }
  /* 긴 이름은 잘라내지 않고 다음 줄로 */
  .bc-team-name,
  .bc-name {
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: keep-all;
  }
  .bc-affil {
    white-space: nowrap;
  }
  .bc-team-name {
    font-size: 0.68rem;
    font-weight: 700;
    color: #475569;
    flex: 0 1 auto;
    min-width: 0;
    line-height: 1.2;
  }
  .lock-chip {
    font-size: 0.6rem;
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
    font-size: 0.88rem;
    color: #0f172a;
    line-height: 1.2;
  }
  /* 투근무 노란 배경은 쓰지 않음. 구분은 .bc-badge.two */
  .bc-affil {
    font-size: 0.66rem;
    font-weight: 700;
    color: #64748b;
    line-height: 1.15;
  }
  .bc-marks {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 2px;
    max-width: 100%;
    overflow: visible;
    min-height: 0;
  }
  .bc-badge {
    display: inline-block;
    font-size: 0.62rem;
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
  .bc-badge.linked { color: #0f766e; background: #ccfbf1; }
  .bc-vacant {
    display: inline-block;
    font-size: 0.68rem;
    font-weight: 800;
    color: #0f172a;
    border: 1px dashed #0f172a;
    border-radius: 4px;
    padding: 0 3px;
  }
  .bc-special {
    font-size: 0.62rem;
    font-weight: 800;
    color: #b45309;
  }
  /* PC: 새 래퍼는 레이아웃에 영향 없음. 하우스 모바일 전용 마크는 PC에서 숨김. */
  .bc-flags { display: contents; }
  .bc-mark-house-mobile { display: none; }
  /* 하우스만 있는 Marks는 PC에서 완전히 숨김(빈 줄 방지). 팀행 하우스만 보임. */
  .bc-marks:not(:has(:not(.bc-mark-house-mobile))) { display: none; }
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
  .pub-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 4px 2px;
  }
  .pub-foot .pub-spare { padding: 4px 0; }
  .pub-totals {
    font-size: 0.82rem;
    font-weight: 800;
    color: #0f172a;
    margin-left: auto;
  }
  .pub-empty-shift {
    padding: 18px 8px;
    text-align: center;
    color: #64748b;
    font-size: 0.85rem;
  }
  @media (max-width: 480px) {
    /* 4코스 동시 표시 + 셀 내부 동일 규칙: 예약자명 / 캐디명 / 조 / 배지.
       캐디 이름은 위 슬롯이 비어도 같은 줄에서 시작(위에서부터 쌓음). */
    .ops-col-time { width: 42px; }
    .ops-col-course { width: calc((100% - 42px) / 4); }
    .ops-board-row > .bc-time { width: 42px; font-size: 0.75rem; }
    .ops-board-row > .bc-time,
    .ops-board-row > .bc-cell {
      min-height: 40px;
      vertical-align: top;
    }
    .ops-board-head th {
      font-size: 0.72rem;
    }
    .bh-count { font-size: 0.6rem; }
    .bc-cell { padding: 2px 1px 3px; overflow: visible; }
    /* display:contents 는 테이블 셀 높이 계산을 깨뜨려 글자가 다음 행과 겹쳤다.
       일반 플로우(flex)로 쌓아 행이 내용만큼 커지게 한다. */
    .bc-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 1px;
      width: 100%;
      min-width: 0;
      min-height: 42px;
      height: auto;
    }
    .bc-caddy {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      min-width: 0;
      gap: 1px;
      flex: 0 0 auto;
    }
    .bc-team {
      flex-direction: column;
      flex-wrap: nowrap;
      width: 100%;
      min-height: 0;
      gap: 0;
      flex: 0 0 auto;
    }
    .bc-team-name-fallback { display: none; }
    .bc-team.is-empty {
      min-height: 0;
      height: 0;
      margin: 0;
      padding: 0;
      overflow: hidden;
      border: 0;
    }
    /* 팀행의 하우스·리무진은 숨기고, Marks(최하단)로 통일. 리무진은 동일 필드 중복. */
    .bc-team .bc-badge { display: none; }
    .bc-mark-house-mobile { display: inline-block; }
    .bc-team-name {
      font-size: 0.56rem;
      line-height: 1.15;
      font-weight: 700;
      max-width: 100%;
      white-space: nowrap;
      overflow: visible;
    }
    .bc-team-name.name-lg,
    .bc-team-name.name-xl {
      font-size: 0.48rem;
      letter-spacing: -0.03em;
    }
    .bc-team-name.name-xl {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: keep-all;
      line-height: 1.1;
    }
    .bc-name {
      font-size: 0.82rem;
      font-weight: 800;
      line-height: 1.15;
      white-space: nowrap;
      max-width: 100%;
      overflow: visible;
      flex: 0 0 auto;
    }
    /* 긴 이름만 축소. 2~4글자는 그대로. */
    .bc-name.name-lg {
      font-size: 0.7rem;
      letter-spacing: -0.02em;
    }
    .bc-name.name-xl {
      font-size: 0.6rem;
      letter-spacing: -0.03em;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: keep-all;
      line-height: 1.12;
    }
    .bc-affil {
      font-size: 0.58rem;
      line-height: 1.1;
    }
    .bc-flags {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      align-items: center;
      gap: 1px;
      width: 100%;
      min-width: 0;
      flex: 0 0 auto;
    }
    .bc-marks { gap: 1px; min-height: 0; }
    .bc-badge, .bc-special { font-size: 0.54rem; padding: 0 2px; line-height: 1.2; }
    .lock-chip { font-size: 0.54rem; min-height: 12px; padding: 0 3px; margin-top: 0; }
  }
`;
