/**
 * 배치표 A4 가로 인쇄 Chromium 검증 (headless Chrome + CDP, 추가 의존성 없음).
 * - 인쇄 media 에서 사이트 메뉴/버튼 숨김, 가로 넘침/칸 넘침 없음
 * - PDF(A4 가로) 생성 → 페이지마다 머리글 반복, 티타임 누락/중복 없음, 부 섞임 없음
 * - 모바일 미리보기 스크린샷
 * 실제 프린터 출력은 검증하지 않는다. DB/네트워크(외부) 없음.
 *
 * 실행: npm run test:assignment-board-print-chromium
 * 산출물: PRINT_A4_OUT (기본 /tmp/board-print-a4)
 */
import React from "react";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignmentBoardPrintSheet } from "../src/components/board/AssignmentBoardPrintSheet";
import PublishedBoardView from "../src/components/board/PublishedBoardView";
import {
  BOARD_PRINT_BODY_CLASS,
  BOARD_PRINT_PORTAL_CLASS,
  assignmentBoardPrintOverlayCss,
  assignmentBoardPrintSheetCss,
} from "../src/components/board/assignmentBoardPrintCss";
import { buildBoardPrintSheet, type BoardPrintSheet } from "../src/lib/assignmentBoardPrint";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { ShiftPart } from "../src/lib/reservationParser";
import {
  emptyAndUnassignedDraft,
  fullLoadDraft,
  GAPPED_SHIFT_TIMES,
  gappedTimetableDraft,
  largeDraft,
  legacySparseThirdShiftDraft,
  OPERATING_SHIFT_TIMES,
  operatingTimetableDraft,
  synthName,
  threeShiftDraft,
} from "./fixtures/boardPrintFixtures";
import { buildPublishedPayloadFromDraft, type DailyBoardPublishedPayloadV1 } from "../src/lib/dailyBoardPublished";
import type { DailyBoardDraftPayloadV1 } from "../src/lib/dailyBoardDraft";
import { publishedBoardPrintDraft } from "../src/lib/publishedBoardPrint";
import { BOARD_SHEET_BASE_ROWS, type BoardSheetModel } from "../src/lib/boardSheet";

(globalThis as unknown as { React: typeof React }).React = React;

const OUT = process.env.PRINT_A4_OUT || "/tmp/board-print-a4";
const PORT = 9333 + Math.floor(Math.random() * 400);
/** A4 가로 297mm - 좌우 여백 8mm*2 = 281mm ≈ 1062px */
const PRINTABLE_W = 1062;
/** 210mm - 8mm - 9mm = 193mm ≈ 729px */
const PRINTABLE_H = 729;

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

function chromePath(): string {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(Boolean) as string[];
  return c.find((p) => existsSync(p)) || "google-chrome";
}

function publishedBoardHtml(payload: ReturnType<typeof buildPublishedPayloadFromDraft>, shift: ShiftPart): string {
  const body = renderToStaticMarkup(<PublishedBoardView payload={payload} shift={shift} />);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>board ${shift}</title><style>html,body{margin:0;padding:8px;background:#fff;font-family:sans-serif}</style></head>
<body>${body}</body></html>`;
}

function pageHtml(sheet: BoardPrintSheet, zoom = 1): string {
  const body = renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={sheet} printedAt="2026-11-11 19:00" />);
  // 실제 관리자 화면처럼 사이트 메뉴/버튼이 있는 문서 + body 직속 인쇄 portal
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>print test</title></head>
<body class="${BOARD_PRINT_BODY_CLASS}">
<header class="site-nav" data-site-ui="1" style="position:sticky;top:0;background:#123;color:#fff;padding:12px">VERTHILL 관리자 메뉴 <button>로그아웃</button></header>
<main data-site-ui="1"><div class="ops-board-tools"><button>자동배치</button><button>엑셀 저장</button><button>인쇄</button></div><table><tr><td>기존 배치표 화면</td></tr></table></main>
<div class="${BOARD_PRINT_PORTAL_CLASS}">
  <div class="bp-toolbar" role="toolbar"><span class="bp-toolbar-title">배치표 인쇄 (A4 가로)</span>
    <div class="bp-shift-tabs">${["1부", "2부", "3부"].map((s) => `<button aria-pressed="${s === sheet.shift}">${s}</button>`).join("")}</div>
    <label><input type="checkbox">예약자명 표시</label><label><input type="checkbox" checked>화면 맞춤</label>
    <div class="bp-toolbar-end"><button class="bp-btn primary">${sheet.shift} 인쇄</button><button class="bp-btn">닫기</button></div>
    <p class="bp-hint">인쇄 창에서 용지 A4 · 가로 방향 · 배율 기본(100%)을 확인하세요.</p></div>
  <div class="bp-stage"><div class="bp-paper"${zoom !== 1 ? ` style="zoom:${zoom}"` : ""}>${body}</div></div>
</div>
<style>${assignmentBoardPrintSheetCss}${assignmentBoardPrintOverlayCss}</style>
</body></html>`;
}

/* ---------- 최소 CDP 클라이언트 (Node 내장 WebSocket) ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP 응답은 메서드마다 형태가 다름
type CdpResult = any;
type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<CdpResult>; close: () => void };
async function connectCdp(): Promise<{ cdp: Cdp; child: ChildProcess }> {
  const userData = mkdtempSync(join(tmpdir(), "board-print-"));
  const child = spawn(chromePath(), [
    `--user-data-dir=${userData}`, "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await delay(100);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || "";
    } catch {
      /* not yet */
    }
  }
  if (!wsUrl) throw new Error("Chrome DevTools 연결 실패");
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map<number, { res: (v: CdpResult) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    }
  };
  return {
    child,
    cdp: {
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          const n = ++id;
          pending.set(n, { res, rej });
          ws.send(JSON.stringify({ id: n, method, params }));
        }),
      close: () => ws.close(),
    },
  };
}

async function load(cdp: Cdp, html: string, width: number, height: number, media: "print" | "screen", mobile = false) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cdp.send("Emulation.setEmulatedMedia", { media });
  const { frameTree } = await cdp.send("Page.getFrameTree");
  await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await delay(250);
}

async function evaluate<T>(cdp: Cdp, expr: string): Promise<T> {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value as T;
}

const LAYOUT_PROBE = `(() => {
  const vw = window.innerWidth;
  const portal = document.querySelector(".${BOARD_PRINT_PORTAL_CLASS}");
  const visibleSiteUi = Array.from(document.querySelectorAll("[data-site-ui] *, [data-site-ui]"))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
  const toolbar = document.querySelector(".bp-toolbar");
  const table = document.querySelector(".bs-table");
  const cells = Array.from(document.querySelectorAll(".bs-table th, .bs-table td"));
  const overflowCells = cells.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    .map((el) => (el.textContent || "").slice(0, 40));
  const escaped = [];
  for (const td of document.querySelectorAll(".bs-cell")) {
    const r = td.getBoundingClientRect();
    for (const ch of td.querySelectorAll(".bs-name, .bs-affil, .bs-mark, .bs-team, .bs-vacant")) {
      const c = ch.getBoundingClientRect();
      if (c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) escaped.push((ch.textContent || "").slice(0, 30));
    }
  }
  const heads = Array.from(document.querySelectorAll("[data-sheet-course-head]")).map((th) => { const r = th.getBoundingClientRect(); return { l: r.left, r: r.right, t: (th.textContent || "").trim() }; });
  const rowHeights = Array.from(document.querySelectorAll(".bs-table tbody tr")).map((tr) => tr.getBoundingClientRect().height);
  const theadH = document.querySelector(".bs-table thead").getBoundingClientRect().height;
  return {
    vw, docScrollW: document.documentElement.scrollWidth, tableW: table.getBoundingClientRect().width,
    portalDisplay: getComputedStyle(portal).position, toolbarDisplay: getComputedStyle(toolbar).display,
    visibleSiteUi, overflowCells, escaped, heads, maxRowH: Math.max(0, ...rowHeights), theadH, rows: rowHeights.length,
  };
})()`;

type Probe = {
  vw: number; docScrollW: number; tableW: number; portalDisplay: string; toolbarDisplay: string;
  visibleSiteUi: number; overflowCells: string[]; escaped: string[]; heads: { l: number; r: number; t: string }[];
  maxRowH: number; theadH: number; rows: number;
};

function hasTool(bin: string): boolean {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
}

async function printCase(cdp: Cdp, name: string, sheet: BoardPrintSheet, opts: { forbidden?: string[]; required?: string[]; pages?: number } = {}) {
  console.log(`[chromium] ${name}`);
  await load(cdp, pageHtml(sheet), PRINTABLE_W, PRINTABLE_H, "print");
  const p = await evaluate<Probe>(cdp, LAYOUT_PROBE);
  assert(p.visibleSiteUi === 0, `${name}: 인쇄 시 사이트 메뉴·버튼 숨김 (보이는 요소 ${p.visibleSiteUi})`);
  assert(p.toolbarDisplay === "none", `${name}: 인쇄 툴바 숨김`);
  assert(p.docScrollW <= p.vw + 1 && p.tableW <= p.vw + 1, `${name}: 가로 넘침 없음 (표 ${Math.round(p.tableW)}px ≤ ${p.vw}px)`);
  assert(p.overflowCells.length === 0, `${name}: 칸 내용 넘침 없음${p.overflowCells.length ? " " + JSON.stringify(p.overflowCells.slice(0, 3)) : ""}`);
  assert(p.escaped.length === 0, `${name}: 이름·표시가 칸 밖으로 나가지 않음${p.escaped.length ? " " + JSON.stringify(p.escaped.slice(0, 3)) : ""}`);
  const courseHeads = p.heads;
  assert(
    courseHeads.length === 4 && courseHeads.every((h, i) => i === 0 || h.l >= courseHeads[i - 1].r - 1),
    `${name}: 4코스 가로 배치·겹침 없음 (${courseHeads.map((h) => h.t.slice(0, 3)).join(" | ")})`
  );
  assert(p.maxRowH + p.theadH < PRINTABLE_H, `${name}: 가장 큰 행(${Math.round(p.maxRowH)}px)+머리글이 한 페이지 안 → 행 잘림 없음`);

  const pdf = await cdp.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true, landscape: true, paperWidth: 11.69, paperHeight: 8.27 });
  const pdfPath = join(OUT, `${name}.pdf`);
  writeFileSync(pdfPath, Buffer.from(pdf.data, "base64"));
  if (!hasTool("pdfinfo") || !hasTool("pdftotext")) {
    console.log("  - poppler 없음: PDF 텍스트 검증 생략");
    return;
  }
  const info = execFileSync("pdfinfo", [pdfPath]).toString();
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] || 0);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(info);
  assert(size && Number(size[1]) > Number(size[2]) && Math.abs(Number(size[1]) - 841.89) < 2, `${name}: PDF A4 가로 (${size?.[1]}x${size?.[2]}pt), ${pages}쪽`);
  const seen = new Map<string, number>();
  // 코스별 실제 시각: 같은 시각이 여러 코스에 있으면 그 수만큼 나와야 한다
  const expected = new Map<string, number>();
  for (const c of sheet.courses) for (const sl of c.slots) expected.set(sl.teeTime, (expected.get(sl.teeTime) || 0) + 1);
  let headerOk = true;
  for (let i = 1; i <= pages; i++) {
    const t = execFileSync("pdftotext", ["-f", String(i), "-l", String(i), "-layout", pdfPath, "-"]).toString();
    if (!["시각", "캐디", "베르힐", "스카이", "오션", "레이크", sheet.shift, sheet.date].every((s) => t.includes(s))) headerOk = false;
    for (const tee of expected.keys()) {
      const n = t.split(tee).length - 1;
      if (n) seen.set(tee, (seen.get(tee) || 0) + n);
    }
    if (hasTool("pdftoppm")) {
      execFileSync("pdftoppm", ["-f", String(i), "-l", String(i), "-r", "110", "-png", "-singlefile", pdfPath, join(OUT, `${name}-p${i}`)]);
    }
  }
  assert(headerOk, `${name}: 모든 쪽에 날짜·부·시각·캐디·4코스 머리글 반복`);
  if (opts.pages != null) assert(pages === opts.pages, `${name}: ${sheet.rowCount}행 → A4 ${opts.pages}쪽 (실제 ${pages}쪽)`);
  const slotsTotal = [...expected.values()].reduce((a, b) => a + b, 0);
  const missing = [...expected.keys()].filter((t) => !seen.has(t));
  const wrong = [...expected.entries()].filter(([t, n]) => (seen.get(t) || 0) !== n).map(([t]) => t);
  assert(missing.length === 0 && wrong.length === 0, `${name}: 코스별 시각 ${slotsTotal}칸 누락·중복 없음${missing.length || wrong.length ? ` missing=${missing} wrong=${wrong.slice(0, 5)}` : ""}`);
  const all = execFileSync("pdftotext", ["-layout", pdfPath, "-"]).toString();
  if (opts.forbidden?.length) {
    const leaked = opts.forbidden.filter((s) => all.includes(s));
    assert(leaked.length === 0, `${name}: 다른 부 데이터 섞임 없음${leaked.length ? " " + leaked.slice(0, 3) : ""}`);
  }
  if (opts.required?.length) {
    const compact = all.replace(/\s+/g, "");
    const lost = opts.required.filter((s) => !compact.includes(String(s).replace(/\s+/g, "")));
    assert(lost.length === 0, `${name}: 자기 부 캐디 ${opts.required.length}명 모두 출력${lost.length ? " 누락:" + lost.slice(0, 3) : ""}`);
  }
  return pages;
}

/** PR 이전: 코스별 배정만 모아 당기고 21행 패딩. 공유 시간축·빈타임 행 없음. */
function packedBeforeSheet(shared: BoardSheetModel): BoardPrintSheet {
  const courses = shared.courses.map((course) => {
    const kept = course.slots.filter((s) => s.state !== "empty");
    const pad = Array.from({ length: Math.max(0, BOARD_SHEET_BASE_ROWS - kept.length) }, () => ({
      teeTime: "",
      state: "empty" as const,
      caddies: [],
      teamNames: [],
    }));
    return { ...course, slots: [...kept, ...pad] };
  });
  return { ...shared, courses, rowCount: Math.max(BOARD_SHEET_BASE_ROWS, ...courses.map((c) => c.slots.length)) };
}

function redactPublished(raw: DailyBoardPublishedPayloadV1): DailyBoardPublishedPayloadV1 {
  return {
    ...raw,
    publisherUsername: "preview",
    placements: raw.placements.map((p, i) => {
      const name = synthName(i + 1);
      return { ...p, caddyName: name, teamName: null, displayLabel: name };
    }),
    sparesByShift: (raw.sparesByShift || []).map((s) => ({
      ...s,
      spare1: s.spare1 ? { ...s.spare1, name: "스페어1", displayLabel: "스페어1" } : null,
      spare2: s.spare2 ? { ...s.spare2, name: "스페어2", displayLabel: "스페어2" } : null,
    })),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { cdp, child } = await connectCdp();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // 1) 저장소 기존 fixture (2026-09-07 draft) 1·2·3부
    const fx = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/board-export-2026-09-07.json"), "utf8")) as AssignmentDraft;
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const own = fx.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name);
      const ownSet = new Set(own);
      const otherOnly = [...new Set(fx.assignments.filter((a) => a.reservation.shift !== shift).map((a) => a.caddy.name))].filter((n) => !ownSet.has(n));
      await printCase(cdp, `fixture-${shift}`, buildBoardPrintSheet(fx, shift), { forbidden: otherOnly, required: [...ownSet] });
    }

    // 1-b) /board: 같은 fixture 를 Published payload 로 만든 뒤 /board 어댑터로 인쇄
    const pubPayload = buildPublishedPayloadFromDraft(fx as unknown as DailyBoardDraftPayloadV1);
    const boardDraft = publishedBoardPrintDraft({ selectedDate: fx.date, loading: false, published: { date: fx.date, payload: pubPayload } });
    assert(boardDraft != null, "/board 어댑터: 확정 데이터 → 인쇄 draft");
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const ownSet = new Set(fx.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
      const otherOnly = [...new Set(fx.assignments.filter((a) => a.reservation.shift !== shift).map((a) => a.caddy.name))].filter((n) => !ownSet.has(n));
      await printCase(cdp, `board-published-${shift}`, buildBoardPrintSheet(boardDraft!, shift), { forbidden: otherOnly, required: [...ownSet] });
    }

    // 2) 합성 3부 draft, 예약자명 ON — 팀명 접두사로 부 섞임 검출
    const syn = threeShiftDraft();
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const forbidden = syn.assignments.filter((a) => a.reservation.shift !== shift).map((a) => String(a.reservation.teamName));
      const required = syn.assignments.filter((a) => a.reservation.shift === shift).map((a) => String(a.reservation.teamName));
      await printCase(cdp, `synthetic-names-${shift}`, buildBoardPrintSheet(syn, shift, { includeTeamName: true }), { forbidden, required });
    }

    // 3) 빈 코스·휴장·미배치
    await printCase(cdp, "empty-unassigned-2부", buildBoardPrintSheet(emptyAndUnassignedDraft(), "2부", { includeTeamName: true }));
    // 4) 데이터 없는 부
    await printCase(cdp, "no-data-1부", buildBoardPrintSheet(emptyAndUnassignedDraft(), "1부"));
    // 5) 여러 쪽으로 넘어가는 큰 배치표 (2인 칸·긴 예약자명)
    const big = buildBoardPrintSheet(largeDraft(), "1부", { includeTeamName: true });
    await printCase(cdp, "large-multipage-1부", big);

    // 5-b) 합성 만석: 코스 시작·간격이 엇갈려 공유 시간축이 21행을 넘으면 2쪽.
    // 빈타임을 유지해서 2쪽이 되는 것이 아니라, SKY 8분 vs 나머지 7분 합집합 행 수 때문.
    const full = fullLoadDraft();
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const ownSet = new Set(full.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
      const otherOnly = full.assignments.filter((a) => a.reservation.shift !== shift).map((a) => a.caddy.name);
      const fullSheet = buildBoardPrintSheet(full, shift);
      const expectPages = fullSheet.rowCount > 21 ? 2 : 1;
      await printCase(cdp, `full21-${shift}`, fullSheet, { forbidden: otherOnly, required: [...ownSet], pages: expectPages });
    }
    // 5-c) 21팀 초과 (오션 24팀): 잘림 없이 24행
    const over = fullLoadDraft({ overflow: [{ shift: "2부", course: "OCEAN", extra: 3 }] });
    const overOwn = new Set(over.assignments.filter((a) => a.reservation.shift === "2부").map((a) => a.caddy.name));
    await printCase(cdp, "overflow24-2부", buildBoardPrintSheet(over, "2부"), { required: [...overOwn] });

    // 5-d) 빈타임 유지: 1·2·3부 시간표 행이 당겨지지 않음
    const gapped = gappedTimetableDraft();
    const gappedPub = buildPublishedPayloadFromDraft(gapped as unknown as DailyBoardDraftPayloadV1);
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const ownSet = new Set(gapped.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
      const otherOnly = [...new Set(gapped.assignments.filter((a) => a.reservation.shift !== shift).map((a) => a.caddy.name))].filter((n) => !ownSet.has(n));
      await printCase(cdp, `gapped-${shift}`, buildBoardPrintSheet(gapped, shift), { forbidden: otherOnly, required: [...ownSet] });
    }

    console.log("[chromium] /board empty tee rows");
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const times = GAPPED_SHIFT_TIMES[shift];
      const hole = times[2];
      await load(cdp, publishedBoardHtml(gappedPub, shift), 390, 844, "screen", true);
      const probe = await evaluate<{ times: string[]; empties: number; lakeEmpty: number }>(
        cdp,
        `(() => {
          const times = Array.from(document.querySelectorAll("[data-board-time]")).map((el) => el.getAttribute("data-board-time") || "");
          const row = document.querySelector('[data-board-time="${hole}"]');
          const empties = row ? row.querySelectorAll('[data-board-cell="empty"]').length : 0;
          const lakeEmpty = Array.from(document.querySelectorAll("tr[data-board-time] td:nth-child(5)[data-board-cell=\\"empty\\"]")).length;
          return { times, empties, lakeEmpty };
        })()`
      );
      assert(probe.times.join() === times.join(), `/board ${shift} 모바일: 시간축 ${times.join(",")}`);
      assert(probe.empties === 4, `/board ${shift} 모바일: ${hole} 4코스 빈칸`);
      if (shift === "3부") assert(probe.lakeEmpty === times.length, "/board 3부 모바일: 레이크 전 행 빈칸");
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `board-gapped-${shift}-mobile.png`), Buffer.from(shot.data, "base64"));
      await load(cdp, publishedBoardHtml(gappedPub, shift), 1440, 900, "screen");
      const pcBoard = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `board-gapped-${shift}-pc.png`), Buffer.from(pcBoard.data, "base64"));
    }

    // 5-e) 운영 티시트(2026-11-11 형태): 공유 21/18칸 → A4 1쪽. 앞·뒤 빈타임 포함.
    const ops = operatingTimetableDraft();
    const opsPub = buildPublishedPayloadFromDraft(ops as unknown as DailyBoardDraftPayloadV1);
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const ownSet = new Set(ops.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
      const otherOnly = [...new Set(ops.assignments.filter((a) => a.reservation.shift !== shift).map((a) => a.caddy.name))].filter((n) => !ownSet.has(n));
      const sheet = buildBoardPrintSheet(ops, shift);
      assert(sheet.rowCount === OPERATING_SHIFT_TIMES[shift].length && sheet.rowCount <= 21, `운영 ${shift}: ${sheet.rowCount}행 ≤ 21`);
      await printCase(cdp, `operating-${shift}`, sheet, { forbidden: otherOnly, required: [...ownSet], pages: 1 });
    }
    const ops3 = buildBoardPrintSheet(ops, "3부");
    const packed3 = packedBeforeSheet(ops3);
    await load(cdp, pageHtml(packed3), PRINTABLE_W, PRINTABLE_H, "print");
    const packedPdf = await cdp.send("Page.printToPDF", { preferCSSPageSize: true, printBackground: true, landscape: true, paperWidth: 11.69, paperHeight: 8.27 });
    writeFileSync(join(OUT, "operating-3부-before-packed.pdf"), Buffer.from(packedPdf.data, "base64"));
    if (hasTool("pdftoppm")) execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-r", "110", "-png", "-singlefile", join(OUT, "operating-3부-before-packed.pdf"), join(OUT, "operating-3부-before-packed-p1")]);
    if (hasTool("pdftotext")) {
      const packedText = execFileSync("pdftotext", ["-layout", join(OUT, "operating-3부-before-packed.pdf"), "-"]).toString();
      const afterText = execFileSync("pdftotext", ["-layout", join(OUT, "operating-3부.pdf"), "-"]).toString();
      assert(afterText.includes("16:33") && afterText.includes("18:32") && afterText.includes("17:08"), "운영 3부 AFTER: 티시트 시작 16:33·종료 18:32·내부 17:08");
      assert(!afterText.includes("18:46"), "운영 3부 AFTER: 18:46 고정 격자 없음");
      assert(packed3.courses.find((c) => c.code === "LAKE")!.slots[0].teeTime === "16:40", "BEFORE 패킹: 레이크 첫 행이 첫 배정 16:40으로 당겨짐");
      assert(ops3.courses.find((c) => c.code === "LAKE")!.slots[0].teeTime === "16:33" && ops3.courses.find((c) => c.code === "LAKE")!.slots[0].state === "empty", "AFTER: 레이크 첫 행은 티시트 16:33 빈칸");
      assert(packedText.includes("16:40"), "BEFORE 패킹: 배정 시각은 있음");
    }
    console.log("[chromium] /board operating empty tees (start–end)");
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const times = OPERATING_SHIFT_TIMES[shift];
      await load(cdp, publishedBoardHtml(opsPub, shift), 390, 844, "screen", true);
      const probe = await evaluate<{ times: string[]; firstEmpty: string[]; last: string }>(
        cdp,
        `(() => {
          const times = Array.from(document.querySelectorAll("[data-board-time]")).map((el) => el.getAttribute("data-board-time") || "");
          const first = document.querySelector('[data-board-time="${times[0]}"]');
          const firstEmpty = first ? Array.from(first.querySelectorAll("[data-board-cell]")).map((el) => el.getAttribute("data-board-cell") || "") : [];
          return { times, firstEmpty, last: times[times.length - 1] || "" };
        })()`
      );
      assert(probe.times.join() === times.join(), `/board 운영 ${shift} 모바일: ${times[0]}~${times[times.length - 1]} (${times.length}칸)`);
      assert(probe.last === times[times.length - 1], `/board 운영 ${shift}: 마지막 ${times[times.length - 1]}`);
      if (shift === "1부") assert(probe.firstEmpty[1] === "empty" && probe.firstEmpty[2] === "empty", "/board 1부 모바일: 06:00 스카이·오션 빈칸");
      if (shift === "3부") assert(probe.firstEmpty[1] === "empty" && probe.firstEmpty[3] === "empty", "/board 3부 모바일: 16:33 스카이·레이크 빈칸");
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `board-operating-${shift}-mobile.png`), Buffer.from(shot.data, "base64"));
      await load(cdp, publishedBoardHtml(opsPub, shift), 1440, 900, "screen");
      const pcBoard = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, `board-operating-${shift}-pc.png`), Buffer.from(pcBoard.data, "base64"));
    }

    const legacy = legacySparseThirdShiftDraft();
    const legacySheet = buildBoardPrintSheet(legacy, "3부");
    await printCase(cdp, "legacy-no-teesheet-3부", legacySheet, { pages: 1 });
    assert(legacySheet.courses[0].slots[0].teeTime === "16:40", "레거시 무티시트 3부: 첫 행=배정 min 16:40 (16:33 없음)");
    assert(!legacySheet.courses.some((c) => c.slots.some((s) => s.teeTime === "16:33" || s.teeTime === "18:46")), "레거시: 티시트 없이 16:33·18:46 발명 없음");
    const legacyPub = buildPublishedPayloadFromDraft(legacy as unknown as DailyBoardDraftPayloadV1);
    await load(cdp, publishedBoardHtml(legacyPub, "3부"), 390, 844, "screen", true);
    const legacyProbe = await evaluate<{ times: string[] }>(cdp, `({ times: Array.from(document.querySelectorAll("[data-board-time]")).map((el) => el.getAttribute("data-board-time") || "") })`);
    assert(legacyProbe.times[0] === "16:40" && !legacyProbe.times.includes("16:33"), "/board 레거시 3부 모바일: 16:33 없음");
    const legacyShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "board-legacy-3부-mobile.png"), Buffer.from(legacyShot.data, "base64"));

    for (const date of ["2026-11-10", "2026-11-11"] as const) {
      const path = `/tmp/published-${date}.json`;
      if (!existsSync(path)) continue;
      const raw = redactPublished(JSON.parse(readFileSync(path, "utf8")) as DailyBoardPublishedPayloadV1);
      const draft = publishedBoardPrintDraft({ selectedDate: date, loading: false, published: { date, payload: raw } });
      assert(draft != null, `실게시본 ${date}: 인쇄 draft`);
      for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
        const sheet = buildBoardPrintSheet(draft!, shift);
        const expectPages = sheet.rowCount > 21 ? 2 : 1;
        await printCase(cdp, `published-${date}-${shift}`, sheet, { pages: expectPages });
        await load(cdp, publishedBoardHtml(raw, shift), 390, 844, "screen", true);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(OUT, `board-published-${date}-${shift}-mobile.png`), Buffer.from(shot.data, "base64"));
      }
    }

    // 6) 모바일 미리보기 (390px, screen media, 화면 맞춤 zoom)
    console.log("[chromium] mobile preview");
    const zoom = Math.min(1, (390 - 16) / 1123);
    await load(cdp, pageHtml(buildBoardPrintSheet(fx, "1부"), zoom), 390, 844, "screen", true);
    const m = await evaluate<{ docW: number; vw: number; toolbarH: number; printBtn: boolean; paperW: number }>(cdp, `(() => {
      const paper = document.querySelector(".bp-paper").getBoundingClientRect();
      const btn = document.querySelector(".bp-btn.primary").getBoundingClientRect();
      return { docW: document.querySelector(".${BOARD_PRINT_PORTAL_CLASS}").scrollWidth, vw: innerWidth, toolbarH: document.querySelector(".bp-toolbar").getBoundingClientRect().height, printBtn: btn.width > 0 && btn.right <= innerWidth, paperW: paper.width * ${zoom} };
    })()`);
    assert(m.docW <= m.vw + 1, `mobile: 미리보기 가로 넘침 없음 (${m.docW} ≤ ${m.vw})`);
    assert(m.printBtn, "mobile: 인쇄 버튼이 화면 안에 보임");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "mobile-preview-390.png"), Buffer.from(shot.data, "base64"));
    // 7) PC 화면 미리보기
    await load(cdp, pageHtml(buildBoardPrintSheet(fx, "2부")), 1440, 900, "screen");
    const pc = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "pc-preview-1440.png"), Buffer.from(pc.data, "base64"));
  } finally {
    cdp.close();
    child.kill("SIGTERM");
  }
  console.log(`\n산출물: ${OUT}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
