/**
 * 390px 배치표: 빈칸 '-' 제거, 열선 정렬, 행 높이 공유, 가로 스크롤 없음.
 * Samsung Internet 실기기는 실행하지 않음.
 *
 * 실행: npm run test:assignment-board-layout-chromium
 */
import React from "react";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PublishedBoardView from "../src/components/board/PublishedBoardView";
import { AssignmentBoardExportView } from "../src/components/board/AssignmentBoardExportView";
import { buildBoardExportSlice } from "../src/lib/assignmentBoardExport";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { AutoAssignmentRow } from "../src/lib/autoAssignEngine";
import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
} from "../src/lib/dailyBoardPublished";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "../src/lib/reservationParser";
import { publishedBoardCss } from "../src/components/board/publishedBoardCss";

(globalThis as unknown as { React: typeof React }).React = React;

const PORT = 8801;
const ARTIFACT_DIR = "/opt/cursor/artifacts";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

type Box = { left: number; top: number; width: number; height: number; text: string };
type Report = {
  emptyDashCount: number;
  unassignedText: string;
  emptyTexts: string[];
  headerLefts: number[];
  rowLefts: number[];
  rowHeights: number[];
  scrollWidth: number;
  clientWidth: number;
  overflowX: string;
};

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) || "google-chrome";
}

function placement(
  course: CourseCode,
  teeTime: string,
  teamName: string,
  caddyName: string,
  extra?: Partial<PublishedPlacementV1>
): PublishedPlacementV1 {
  return {
    shift: "3부",
    course,
    teeTime,
    teamName,
    reservationId: `${course}-${teeTime}`,
    reservationKey: `${course}-${teeTime}`,
    caddyId: 1,
    caddyName,
    caddyTeam: "1조",
    displayLabel: `${caddyName} 1조`,
    kind: "regular",
    locked: extra?.locked === true,
    limousine: false,
    driving: false,
    twoWork: false,
    chageun: false,
    specialSupport: false,
    sequenceIndex: 0,
    ...extra,
  };
}

function publishedPayload(): DailyBoardPublishedPayloadV1 {
  return {
    schemaVersion: 1,
    date: "2026-09-07",
    openCourses: [...COURSE_CODES],
    publisherUsername: "test",
    teeSheet: [
      { course: "VERTHILL", shift: "3부", teeTime: "16:33" },
      { course: "VERTHILL", shift: "3부", teeTime: "16:40" },
      { course: "VERTHILL", shift: "3부", teeTime: "16:47" },
      { course: "VERTHILL", shift: "3부", teeTime: "16:54" },
      { course: "VERTHILL", shift: "3부", teeTime: "17:01" },
      { course: "VERTHILL", shift: "3부", teeTime: "17:08" },
      { course: "SKY", shift: "3부", teeTime: "16:40" },
      { course: "SKY", shift: "3부", teeTime: "16:48" },
      { course: "OCEAN", shift: "3부", teeTime: "16:40" },
      { course: "LAKE", shift: "3부", teeTime: "16:47" },
    ],
    placements: [
      placement("VERTHILL", "16:40", "합성팀V1", "김배정", { locked: true }),
      placement("SKY", "16:40", "합성팀S1", "정스카이"),
      placement("OCEAN", "16:40", "합성팀O1", "오오션"),
      placement("VERTHILL", "16:47", "합성팀V2", "이배정"),
      placement("LAKE", "16:47", "합성팀L1", "라레이크"),
      placement("SKY", "16:48", "합성팀S2", "한스카이"),
      placement("VERTHILL", "16:54", "합성팀V3", "박배정"),
      placement("VERTHILL", "17:08", "합성팀V4", "최배정"),
    ],
    sparesByShift: [],
  };
}

function assignmentRow(
  teeTime: string,
  course: CourseCode,
  id: string,
  name: string
): AutoAssignmentRow {
  return {
    date: "2026-09-07",
    shift: "3부",
    sequenceIndex: 0,
    reason: "TEST",
    kind: "regular",
    pairId: null,
    reservation: {
      id,
      date: "2026-09-07",
      course,
      shift: "3부",
      teeTime,
      teamName: `합성팀${id}`,
      rawRowIndex: 1,
    },
    caddy: { id: Number(id.replace(/\D/g, "") || 1), name, team: "1조", teamOrder: 1 },
  } as AutoAssignmentRow;
}

function exportDraft(): AssignmentDraft {
  return {
    date: "2026-09-07",
    status: "DRAFT",
    assignments: [
      assignmentRow("16:40", "VERTHILL", "V1", "김배정"),
      assignmentRow("16:47", "VERTHILL", "V2", "이배정"),
      assignmentRow("16:54", "VERTHILL", "V3", "박배정"),
      assignmentRow("17:08", "VERTHILL", "V4", "최배정"),
    ],
    unassignedReservations: [
      {
        reservation: {
          id: "u1633",
          date: "2026-09-07",
          course: "VERTHILL",
          shift: "3부",
          teeTime: "16:33",
          teamName: "미배정팀",
          rawRowIndex: 1,
        },
        reason: "OPEN",
      },
    ],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    sparesByShift: [{ shift: "3부", spare1: null, spare2: null }],
    confirmedAt: null,
    teeSheet: publishedPayload().teeSheet,
  };
}

const manageCss = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: sans-serif; background: #fff; }
  .ops-board-scope {
    --ops-board-line: #cbd5e1;
    --ops-board-time-col: 52px;
    --ops-board-cols: var(--ops-board-time-col) repeat(4, minmax(0, 1fr));
    min-width: 0; max-width: 100%;
  }
  .ops-board-head-bar {
    width: 100%; box-sizing: border-box;
    border: 1px solid var(--ops-board-line); border-bottom: 0;
    border-radius: 8px 8px 0 0; overflow: hidden; background: #0f172a;
  }
  .ops-board-wrap { width: 100%; max-width: 100%; min-width: 0; overflow-x: clip; overflow-y: visible; }
  .ops-board {
    width: 100%; max-width: 100%; min-width: 0; display: grid; gap: 0;
    border: 1px solid var(--ops-board-line); border-radius: 0 0 8px 8px;
    overflow: hidden; background: #fff; box-sizing: border-box;
  }
  .ops-board-head, .ops-board-row {
    display: grid; grid-template-columns: var(--ops-board-cols);
    align-items: stretch; width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box;
  }
  .ops-board-head { background: #0f172a; color: #fff; }
  .ops-board-head > div {
    box-sizing: border-box; min-width: 0; padding: 6px 2px; text-align: center;
    font-size: 0.72rem; font-weight: 800; border-right: 1px solid #334155;
  }
  .ops-board-head > div:last-child { border-right: 0; }
  .ops-board-block + .ops-board-block { border-top: 1px solid var(--ops-board-line); }
  .ops-board-row > .bc-time, .ops-board-row > .bc-cell {
    box-sizing: border-box; min-width: 0; align-self: stretch;
  }
  .ops-board-row > .bc-time {
    display: flex; align-items: center; justify-content: center;
    font-size: 0.68rem; font-weight: 800; font-variant-numeric: tabular-nums;
    white-space: nowrap; color: #334155; background: #f8fafc;
    border-right: 1px solid var(--ops-board-line); padding: 4px 1px; min-height: 40px;
  }
  .bc-cell {
    min-width: 0; min-height: 40px; padding: 4px 2px;
    border-right: 1px solid var(--ops-board-line);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; font-size: 0.72rem; line-height: 1.2; background: #fff;
  }
  .ops-board-row > .bc-cell:last-child { border-right: 0; }
  .bc-cell.empty { padding: 0; }
  .bc-empty-hit {
    appearance: none; display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 40px; height: 100%; margin: 0; border: 0; background: transparent;
    font: inherit; cursor: pointer;
  }
  .bc-cell.unassigned { color: #b45309; background: #fffbeb; font-weight: 700; font-size: 0.68rem; }
  .bc-slot { display: flex; flex-direction: column; align-items: center; width: 100%; min-width: 0; gap: 1px; }
  .bc-team, .bc-caddy {
    width: 100%; min-width: 0; padding: 1px 2px; display: flex; flex-direction: column;
    align-items: center; text-align: center;
  }
  .bc-team-name, .bc-name, .bc-affil {
    max-width: 100%; overflow-wrap: anywhere; word-break: keep-all; white-space: normal; text-align: center;
  }
  .bc-team-name { font-size: 0.58rem; font-weight: 700; color: #475569; }
  .bc-name { font-weight: 800; font-size: 0.78rem; color: #0f172a; }
  .bc-affil { font-size: 0.55rem; font-weight: 700; color: #64748b; }
  .lock-chip { font-size: 0.58rem; padding: 1px 5px; border-radius: 999px; background: #e2e8f0; font-weight: 800; }
`;

function manageBoardHtml(): string {
  return `<div class="ops-board-scope" data-layout-manage="1" style="padding:8px">
    <div class="ops-board-head-bar" data-layout-head="1">
      <div class="ops-board-head">
        <div class="bh-time">시간</div>
        <div class="bh-course">베</div>
        <div class="bh-course">스</div>
        <div class="bh-course">오</div>
        <div class="bh-course">레</div>
      </div>
    </div>
    <div class="ops-board-wrap">
      <div class="ops-board">
        <div class="ops-board-block">
          <div class="ops-board-row" data-layout-row="unassigned">
            <div class="bc-time">16:33</div>
            <div class="bc-cell unassigned" data-board-cell="unassigned"><span class="bc-unassigned">미배치</span></div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
          </div>
        </div>
        <div class="ops-board-block">
          <div class="ops-board-row" data-layout-row="tall">
            <div class="bc-time">16:40</div>
            <div class="bc-cell assigned">
              <div class="bc-slot">
                <div class="bc-team"><span class="bc-team-name">합성팀V1</span></div>
                <div class="bc-caddy"><span class="bc-name">김배정</span><span class="bc-affil">1조</span></div>
                <span class="lock-chip">LOCK</span>
              </div>
            </div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
            <div class="bc-cell empty" data-board-cell="empty"><button type="button" class="bc-empty-hit" aria-label="추가팀 등록"></button></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function htmlPage(): string {
  const published = renderToStaticMarkup(
    createElement(PublishedBoardView, { payload: publishedPayload(), shift: "3부" as ShiftPart })
  );
  const exportHtml = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(exportDraft(), "3부"),
    })
  );
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=390, initial-scale=1" />
<title>board layout 390</title>
<style>
  ${manageCss}
  ${publishedBoardCss}
  .shot-390 { width: 390px; max-width: 100%; overflow: hidden; }
  .export-wrap { width: 720px; transform: scale(0.54); transform-origin: top left; }
</style>
</head>
<body>
  <div class="shot-390" data-shot="390">
    ${manageBoardHtml()}
    <div data-layout-published="1">${published}</div>
  </div>
  <div class="export-wrap" data-shot="export">${exportHtml}</div>
<script>
function box(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, text: (el.innerText || "").trim() };
}
function lefts(root, sel) {
  return Array.from(root.querySelectorAll(sel)).map((el) => Math.round(el.getBoundingClientRect().left));
}
async function run() {
  const manage = document.querySelector("[data-layout-manage]");
  const head = manage.querySelector(".ops-board-head");
  const tall = manage.querySelector("[data-layout-row=tall]");
  const empties = Array.from(manage.querySelectorAll('[data-board-cell="empty"]'));
  const unassigned = manage.querySelector('[data-board-cell="unassigned"]');
  const dashNodes = Array.from(document.querySelectorAll(".shot-390 .bc-cell.empty, .shot-390 .bx-cell.empty"))
    .filter((el) => (el.textContent || "").trim() === "-");
  const wrap = manage.querySelector(".ops-board-wrap");
  const report = {
    emptyDashCount: dashNodes.length,
    unassignedText: (unassigned && unassigned.textContent || "").trim(),
    emptyTexts: empties.map((el) => (el.textContent || "").trim()),
    headerLefts: lefts(head, ":scope > div"),
    rowLefts: lefts(tall, ":scope > *"),
    rowHeights: Array.from(tall.children).map((el) => Math.round(el.getBoundingClientRect().height)),
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
    overflowX: getComputedStyle(wrap).overflowX,
  };
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
  document.body.setAttribute("data-done", "1");
}
run().catch((e) => {
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) });
});
</script>
</body></html>`;
}

async function screenshot(url: string, outfile: string, size: string) {
  const userData = mkdtempSync(join(tmpdir(), "board-layout-shot-"));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      chromePath(),
      [
        `--user-data-dir=${userData}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-background-networking",
        "--hide-scrollbars",
        `--window-size=${size}`,
        `--screenshot=${outfile}`,
        url,
      ],
      { stdio: "ignore" }
    );
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      resolve();
    }, 12000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  let report: Report | { error?: string } | null = null;
  const html = htmlPage();
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(join(ARTIFACT_DIR, "board_blank_empty_390.html"), html, "utf8");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url || "").startsWith("/report") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        try {
          report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          report = null;
        }
        send(res, 200, '{"ok":true}', "application/json");
      });
      return;
    }
    send(res, 200, html, "text/html; charset=utf-8");
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const userData = mkdtempSync(join(tmpdir(), "board-layout-"));
  let child: ChildProcess | null = null;
  try {
    child = spawn(
      chromePath(),
      [
        `--user-data-dir=${userData}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-background-networking",
        "--window-size=390,844",
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: "ignore" }
    );
    const started = Date.now();
    while (!report && Date.now() - started < 25000) {
      await delay(120);
    }
    if (!report || "error" in report) {
      throw new Error(`Chromium layout report missing: ${JSON.stringify(report)}`);
    }
    const r = report as Report;
    assert(r.emptyDashCount === 0, "빈칸에 '-' 없음");
    assert(r.unassignedText === "미배치", "미배정 칸 미배치");
    assert(r.emptyTexts.every((t) => t === ""), "예약 없는 칸은 완전 빈칸");
    assert(r.headerLefts.length === 5 && r.rowLefts.length === 5, "5열");
    assert(
      r.headerLefts.every((x, i) => Math.abs(x - r.rowLefts[i]) <= 1),
      "헤더·행 세로선 정렬"
    );
    const h0 = r.rowHeights[0];
    assert(
      r.rowHeights.every((h) => Math.abs(h - h0) <= 1),
      "같은 티타임 행 높이 공유"
    );
    assert(r.scrollWidth <= r.clientWidth + 1, "가로 스크롤 없음");
    assert(r.overflowX === "clip" || r.overflowX === "hidden", "overflow-x clip");

    await screenshot(
      `http://127.0.0.1:${PORT}/`,
      join(ARTIFACT_DIR, "board_blank_empty_390.png"),
      "390,844"
    );
    await screenshot(
      `http://127.0.0.1:${PORT}/`,
      join(ARTIFACT_DIR, "board_export_blank_empty.png"),
      "720,1100"
    );
    assert(existsSync(join(ARTIFACT_DIR, "board_blank_empty_390.png")), "390px 캡처");
  } finally {
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
