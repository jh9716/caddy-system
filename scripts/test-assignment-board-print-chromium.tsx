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
import {
  BOARD_PRINT_BODY_CLASS,
  BOARD_PRINT_PORTAL_CLASS,
  assignmentBoardPrintOverlayCss,
  assignmentBoardPrintSheetCss,
} from "../src/components/board/assignmentBoardPrintCss";
import { buildBoardPrintSheet, type BoardPrintSheet } from "../src/lib/assignmentBoardPrint";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { ShiftPart } from "../src/lib/reservationParser";
import { emptyAndUnassignedDraft, largeDraft, threeShiftDraft } from "./fixtures/boardPrintFixtures";
import { buildPublishedPayloadFromDraft } from "../src/lib/dailyBoardPublished";
import type { DailyBoardDraftPayloadV1 } from "../src/lib/dailyBoardDraft";
import { publishedBoardPrintDraft } from "../src/lib/publishedBoardPrint";

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
  const table = document.querySelector(".bp-table");
  const cells = Array.from(document.querySelectorAll(".bp-table th, .bp-table td"));
  const overflowCells = cells.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    .map((el) => (el.textContent || "").slice(0, 40));
  const escaped = [];
  for (const td of document.querySelectorAll(".bp-cell")) {
    const r = td.getBoundingClientRect();
    for (const ch of td.querySelectorAll(".bp-name, .bp-affil, .bp-mark, .bp-team, .bp-vacant")) {
      const c = ch.getBoundingClientRect();
      if (c.left < r.left - 0.5 || c.right > r.right + 0.5 || c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) escaped.push((ch.textContent || "").slice(0, 30));
    }
  }
  const heads = Array.from(document.querySelectorAll(".bp-head-row th")).map((th) => { const r = th.getBoundingClientRect(); return { l: r.left, r: r.right, t: (th.textContent || "").trim() }; });
  const rowHeights = Array.from(document.querySelectorAll(".bp-table tbody tr")).map((tr) => tr.getBoundingClientRect().height);
  const theadH = document.querySelector(".bp-table thead").getBoundingClientRect().height;
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

async function printCase(cdp: Cdp, name: string, sheet: BoardPrintSheet, opts: { forbidden?: string[]; required?: string[] } = {}) {
  console.log(`[chromium] ${name}`);
  await load(cdp, pageHtml(sheet), PRINTABLE_W, PRINTABLE_H, "print");
  const p = await evaluate<Probe>(cdp, LAYOUT_PROBE);
  assert(p.visibleSiteUi === 0, `${name}: 인쇄 시 사이트 메뉴·버튼 숨김 (보이는 요소 ${p.visibleSiteUi})`);
  assert(p.toolbarDisplay === "none", `${name}: 인쇄 툴바 숨김`);
  assert(p.docScrollW <= p.vw + 1 && p.tableW <= p.vw + 1, `${name}: 가로 넘침 없음 (표 ${Math.round(p.tableW)}px ≤ ${p.vw}px)`);
  assert(p.overflowCells.length === 0, `${name}: 칸 내용 넘침 없음${p.overflowCells.length ? " " + JSON.stringify(p.overflowCells.slice(0, 3)) : ""}`);
  assert(p.escaped.length === 0, `${name}: 이름·표시가 칸 밖으로 나가지 않음${p.escaped.length ? " " + JSON.stringify(p.escaped.slice(0, 3)) : ""}`);
  const courseHeads = p.heads.slice(1);
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
  let headerOk = true;
  for (let i = 1; i <= pages; i++) {
    const t = execFileSync("pdftotext", ["-f", String(i), "-l", String(i), "-layout", pdfPath, "-"]).toString();
    if (!["시간", "베르힐", "스카이", "오션", "레이크", sheet.shift, sheet.date].every((s) => t.includes(s))) headerOk = false;
    for (const tr of sheet.rows) {
      const n = t.split(tr.teeTime).length - 1;
      if (n) seen.set(tr.teeTime, (seen.get(tr.teeTime) || 0) + n);
    }
    if (hasTool("pdftoppm")) {
      execFileSync("pdftoppm", ["-f", String(i), "-l", String(i), "-r", "110", "-png", "-singlefile", pdfPath, join(OUT, `${name}-p${i}`)]);
    }
  }
  assert(headerOk, `${name}: 모든 쪽에 날짜·부·시간·4코스 머리글 반복`);
  const missing = sheet.rows.filter((tr) => !seen.has(tr.teeTime)).map((tr) => tr.teeTime);
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  assert(missing.length === 0 && dup.length === 0, `${name}: 티타임 ${sheet.rows.length}행 누락·중복 없음${missing.length || dup.length ? ` missing=${missing} dup=${dup}` : ""}`);
  const all = execFileSync("pdftotext", ["-layout", pdfPath, "-"]).toString();
  if (opts.forbidden?.length) {
    const leaked = opts.forbidden.filter((s) => all.includes(s));
    assert(leaked.length === 0, `${name}: 다른 부 데이터 섞임 없음${leaked.length ? " " + leaked.slice(0, 3) : ""}`);
  }
  if (opts.required?.length) {
    const lost = opts.required.filter((s) => !all.includes(s));
    assert(lost.length === 0, `${name}: 자기 부 캐디 ${opts.required.length}명 모두 출력${lost.length ? " 누락:" + lost.slice(0, 3) : ""}`);
  }
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
