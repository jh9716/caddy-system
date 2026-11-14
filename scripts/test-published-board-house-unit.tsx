/**
 * /board 하우스 배지·리무진 주황 띠 회귀 (엔진/DB 없음).
 * 실행: npm run test:published-board-house-unit
 *
 * - 관리자 판정(boardAssignmentMarks / reservation.houseRequest)과
 *   Published houseRequest, /board 렌더, export draft가 일치하는지
 * - 2026-11-01 1부 06:07 레이크(하우스만) 및 여러 날짜·1/2/3부
 * - 관리자·캐디 뷰, 모바일·PC computed style (Chromium)
 * - 리무진 배지는 유지, 칸 주황 하단 띠는 /board에서 없음
 */
import React, { createElement } from "react";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as { React: typeof React }).React = React;

import PublishedBoardView from "../src/components/board/PublishedBoardView";
import { publishedBoardCss } from "../src/components/board/publishedBoardCss";
import { boardAssignmentMarks } from "../src/lib/assignmentBoardView";
import { assignmentDraftFromPublishedPayload } from "../src/lib/assignmentBoardExport";
import {
  buildPublishedPayloadFromDraft,
  parseDailyBoardPublishedPayload,
  type DailyBoardPublishedPayloadV1,
} from "../src/lib/dailyBoardPublished";
import type { DailyBoardDraftPayloadV1 } from "../src/lib/dailyBoardDraft";
import { publishedPayloadForReader } from "../src/lib/publishedBoardPrivacy";
import { buildBoardSheetModel } from "../src/lib/boardSheet";
import { AssignmentBoardPrintSheet } from "../src/components/board/AssignmentBoardPrintSheet";
import {
  nov1Lake0607HouseDraft,
  shortMorningNov1Draft,
  threeShiftDraft,
} from "./fixtures/boardPrintFixtures";
import type { ShiftPart } from "../src/lib/reservationParser";

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
function section(title: string) {
  console.log("\n==", title, "==");
}

function pubOf(draft: { date: string }) {
  return buildPublishedPayloadFromDraft(draft as unknown as DailyBoardDraftPayloadV1);
}
function htmlOf(payload: DailyBoardPublishedPayloadV1, shift: ShiftPart) {
  return renderToStaticMarkup(createElement(PublishedBoardView, { payload, shift }));
}
function cellHtml(html: string, time: string, course: string): string {
  const row = html.split("data-board-time=").find((s) => s.startsWith(`"${time}"`));
  if (!row) return "";
  const re = new RegExp(`data-board-course="${course}"[^>]*>([\\s\\S]*?)</td>`);
  const m = row.match(re);
  return m ? m[0] : "";
}

section("원인 고정: CSS 소스 (모바일 Marks 숨김 · 주황 띠)");
{
  const css = publishedBoardCss;
  assert(
    !/inset\s+0\s+-3px\s+0\s+#f59e0b/.test(css) &&
      !/\.bc-cell\.assigned\.limo\s*\{[^}]*box-shadow/.test(css),
    "/board CSS: 리무진 칸 주황 하단 띠 규칙 없음"
  );
  assert(
    /\.bc-badge\.limo\s*\{[\s\S]*?background:\s*#fb923c/.test(css) &&
      /\.bc-badge\.limo\s*\{[\s\S]*?color:\s*#9a3412/.test(css),
    "/board CSS: 리무진 배지 색 유지"
  );
  assert(
    /\.bc-badge\.house\s*\{[\s\S]*?background:\s*#dcfce7/.test(css) &&
      /\.bc-badge\.house\s*\{[\s\S]*?color:\s*#166534/.test(css),
    "/board CSS: 하우스 배지 색 유지"
  );
  // 하우스 단독 Marks 숨김은 PC 전용이어야 한다.
  const hide = /\.bc-marks:not\(:has\(:not\(\.bc-mark-house-mobile\)\)\)\s*\{\s*display:\s*none/;
  assert(hide.test(css), "PC: 하우스만 있는 Marks 숨김 규칙 존재 (팀행 배지 사용)");
  const idx = css.search(hide);
  const before = css.slice(0, idx);
  const lastMin = before.lastIndexOf("@media (min-width: 481px)");
  const lastMax = before.lastIndexOf("@media (max-width: 480px)");
  assert(
    lastMin >= 0 && lastMin > lastMax,
    "하우스 단독 Marks 숨김은 @media (min-width: 481px) 안에만 있음"
  );
  assert(
    /@media \(max-width: 480px\)[\s\S]*\.bc-marks\s*\{\s*display:\s*inline-flex/.test(css),
    "모바일: .bc-marks display:inline-flex 로 하우스 단독도 보임"
  );
  const mobileCss = css.slice(css.lastIndexOf("@media (max-width: 480px)"));
  const pcCss = css.slice(0, css.lastIndexOf("@media (max-width: 480px)"));
  assert(
    /--pub-board-row-h:\s*64px/.test(mobileCss) &&
      /\.pub-board-root \.ops-board-row\s*\{[\s\S]*?height:\s*var\(--pub-board-row-h\)/.test(mobileCss) &&
      /max-height:\s*var\(--pub-board-row-h\)/.test(mobileCss),
    "/board 모바일: .pub-board-root 범위에서 행 높이 64px 고정 (height=max-height)"
  );
  assert(!/--pub-board-row-h/.test(pcCss), "PC CSS: --pub-board-row-h 없음");
  assert(
    !/\.ops-board-row\s*>\s*\.bc-cell\s*\{[^}]*min-height:\s*40px/.test(mobileCss),
    "모바일 행 높이는 전역 .ops-board-row min-height:40 이 아님"
  );
  const manage = readFileSync("src/app/manage/assignments/page.tsx", "utf8");
  assert(
    !/inset 0 -3px 0/.test(manage),
    "/manage/assignments: 이번 작업에서 주황 띠를 손대지 않음 (원래도 없음)"
  );
  const exportCss = readFileSync("src/components/board/assignmentBoardExportCss.ts", "utf8");
  assert(
    /\.bx-cell\.assigned\.limo\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px #c47a32/.test(exportCss),
    "인쇄/PNG/XLSX용 export CSS 리무진 테두리(다른 스타일)는 그대로"
  );
}

section("일관성: 관리자 판정 = Published houseRequest = /board 렌더");
{
  const dates = ["2026-11-01", "2026-11-15"];
  for (const date of dates) {
    const draft = nov1Lake0607HouseDraft(date);
    const payload = pubOf(draft);
    const exportDraft = assignmentDraftFromPublishedPayload(payload);
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      const rows = draft.assignments.filter((r) => r.reservation.shift === shift);
      const adminHtml = htmlOf(publishedPayloadForReader(payload, "admin"), shift);
      const caddyHtml = htmlOf(publishedPayloadForReader(payload, "caddy"), shift);
      const printHtml = renderToStaticMarkup(
        createElement(AssignmentBoardPrintSheet, {
          sheet: buildBoardSheetModel(exportDraft, shift),
        })
      );
      for (const row of rows) {
        const marks = boardAssignmentMarks(row, draft.assignments);
        const course = String(row.reservation.course);
        const tee = String(row.reservation.teeTime);
        const pub = payload.placements.find(
          (p) => p.shift === shift && p.course === course && p.teeTime === tee
        );
        const exp = exportDraft.assignments.find(
          (a) => a.reservation.shift === shift && a.reservation.course === course && a.reservation.teeTime === tee
        );
        assert(
          pub != null && pub.houseRequest === marks.houseRequest,
          `${date} ${shift} ${course} ${tee}: 관리자 marks.houseRequest=${marks.houseRequest} == published`
        );
        const cellA = cellHtml(adminHtml, tee, course);
        const cellC = cellHtml(caddyHtml, tee, course);
        if (marks.houseRequest) {
          assert(
            cellA.includes(">하우스<") && cellC.includes(">하우스<"),
            `${date} ${shift} ${course} ${tee}: /board 관리자·캐디 HTML에 하우스`
          );
          assert(
            (pub!.houseRequest === true) &&
              publishedPayloadForReader(payload, "caddy").placements.find(
                (p) => p.shift === shift && p.course === course && p.teeTime === tee
              )?.houseRequest === true,
            `${date} ${shift} ${course} ${tee}: 캐디 redaction이 houseRequest를 제거하지 않음 (teamName만 제거)`
          );
          assert(
            exp?.reservation.houseRequest === true,
            `${date} ${shift} ${course} ${tee}: export draft가 houseRequest를 유지`
          );
          assert(
            printHtml.includes(">하우스<"),
            `${date} ${shift}: /board 경유 인쇄 시트에 하우스 배지`
          );
        } else {
          assert(
            !cellA.includes(">하우스<") && !cellC.includes(">하우스<"),
            `${date} ${shift} ${course} ${tee}: 하우스 없는 칸은 배지 없음`
          );
        }
        if (marks.limousine) {
          assert(cellA.includes(">리무진<"), `${date} ${shift} ${course} ${tee}: 리무진 배지 유지`);
        }
      }
    }
  }
}

section("2026-11-01 1부 06:07 레이크 (하우스만) 픽스처");
{
  const draft = nov1Lake0607HouseDraft("2026-11-01");
  const row = draft.assignments.find(
    (r) =>
      r.reservation.shift === "1부" &&
      r.reservation.course === "LAKE" &&
      r.reservation.teeTime === "06:07"
  );
  assert(!!row, "픽스처에 06:07 레이크 행 있음");
  const marks = boardAssignmentMarks(row!, draft.assignments);
  assert(marks.houseRequest === true, "관리자 판정: 06:07 레이크 하우스");
  assert(
    marks.limousine === false && marks.twoWork === false && marks.chageun === false && marks.driving === false,
    "06:07 레이크는 하우스 단독 (다른 배지 없음 — 모바일 숨김 회귀 재현)"
  );
  const payload = pubOf(draft);
  const pub = payload.placements.find(
    (p) => p.shift === "1부" && p.course === "LAKE" && p.teeTime === "06:07"
  );
  assert(pub?.houseRequest === true, "Published houseRequest true");
  const h = htmlOf(payload, "1부");
  const cell = cellHtml(h, "06:07", "LAKE");
  assert(cell.includes(">하우스<") && cell.includes("bc-mark-house-mobile"), "HTML: 팀행+모바일 Marks 하우스");
  assert(cell.includes("김하우"), "캐디명 표시");
  // 리무진 칸(같은 시각 베르힐)은 배지 있고 셀에 limo 클래스
  const limoCell = cellHtml(h, "06:07", "VERTHILL");
  assert(limoCell.includes(">리무진<") && /bc-cell assigned limo/.test(limoCell), "06:07 베르힐 리무진 배지+클래스");
}

section("다른 픽스처·shortMorning 하우스 칸도 동일 경로");
{
  const morning = shortMorningNov1Draft();
  const payload = pubOf(morning);
  for (const row of morning.assignments) {
    const marks = boardAssignmentMarks(row, morning.assignments);
    if (!marks.houseRequest) continue;
    const pub = payload.placements.find(
      (p) =>
        p.shift === row.reservation.shift &&
        p.course === row.reservation.course &&
        p.teeTime === row.reservation.teeTime
    );
    assert(pub?.houseRequest === true, `shortMorning ${row.reservation.course} ${row.reservation.teeTime} published house`);
    const cell = cellHtml(htmlOf(payload, "1부"), String(row.reservation.teeTime), String(row.reservation.course));
    assert(cell.includes(">하우스<"), `shortMorning ${row.reservation.course} ${row.reservation.teeTime} /board 하우스`);
  }
  const three = threeShiftDraft("2026-11-20");
  const p3 = pubOf(three);
  const houseRows = three.assignments.filter((r) => boardAssignmentMarks(r, three.assignments).houseRequest);
  assert(houseRows.length > 0, "threeShiftDraft에 하우스 요청 행 있음");
  for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
    const h = htmlOf(p3, shift);
    const n = houseRows.filter((r) => r.reservation.shift === shift);
    if (n.length) assert(h.includes(">하우스<"), `threeShift ${shift} /board 하우스`);
  }
}

section("파싱: 필드 없는 구 스냅샷은 발명하지 않음 (재확정 안내)");
{
  const draft = nov1Lake0607HouseDraft("2026-11-01");
  const payload = pubOf(draft);
  const raw = JSON.parse(JSON.stringify(payload)) as DailyBoardPublishedPayloadV1;
  const lake = raw.placements.find((p) => p.shift === "1부" && p.course === "LAKE" && p.teeTime === "06:07")!;
  delete lake.houseRequest;
  const parsed = parseDailyBoardPublishedPayload(raw, "2026-11-01");
  const again = parsed.placements.find((p) => p.shift === "1부" && p.course === "LAKE" && p.teeTime === "06:07")!;
  assert(again.houseRequest === false, "구 스냅샷에 houseRequest 없으면 false (데이터로 복원 불가)");
  const h = htmlOf(parsed, "1부");
  assert(!cellHtml(h, "06:07", "LAKE").includes(">하우스<"), "필드 없는 스냅샷은 /board에 하우스 없음 → 재확정 필요");
}

section("권한: 캐디는 예약자명만 숨기고 하우스는 유지");
{
  const payload = pubOf(nov1Lake0607HouseDraft("2026-11-01"));
  const admin = publishedPayloadForReader(payload, "admin");
  const caddy = publishedPayloadForReader(payload, "caddy");
  const a = admin.placements.find((p) => p.teeTime === "06:07" && p.course === "LAKE")!;
  const c = caddy.placements.find((p) => p.teeTime === "06:07" && p.course === "LAKE")!;
  assert(a.teamName === "레이크하우팀" && c.teamName === null, "캐디: teamName redaction");
  assert(a.houseRequest === true && c.houseRequest === true, "캐디: houseRequest 유지");
  const caddyHtml = htmlOf(caddy, "1부");
  assert(!caddyHtml.includes("레이크하우팀"), "캐디 화면: 예약자명 없음");
  assert(cellHtml(caddyHtml, "06:07", "LAKE").includes(">하우스<"), "캐디 화면 HTML: 하우스 있음");
}

/* ---------- Chromium computed style ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CdpResult = any;
type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<CdpResult>; close: () => void };

function chromePath(): string {
  const c = [process.env.CHROME_PATH, "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(Boolean) as string[];
  return c.find((p) => existsSync(p)) || "google-chrome";
}

async function connectCdp(port: number): Promise<{ cdp: Cdp; child: ChildProcess }> {
  const userData = mkdtempSync(join(tmpdir(), "house-unit-"));
  const child = spawn(chromePath(), [
    `--user-data-dir=${userData}`, "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--remote-debugging-port=${port}`, "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await delay(100);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || "";
    } catch { /* not yet */ }
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

async function evaluate<T>(cdp: Cdp, expr: string): Promise<T> {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value as T;
}

type Probe = {
  visibleHouse: boolean;
  visibleLimo: boolean;
  orangeBand: boolean;
  boxShadow: string;
  hscroll: boolean;
  inner: number;
};

const PROBE = `(() => {
  function vis(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && r.width > 0 && r.height > 0;
  }
  function cell(time, course) {
    const td = document.querySelector('[data-board-time="'+time+'"] [data-board-course="'+course+'"]');
    if (!td) return { missing: true, visibleHouse: false, visibleLimo: false, orangeBand: false, boxShadow: '', hscroll: false, inner: window.innerWidth };
    const shadow = getComputedStyle(td).boxShadow || '';
    return {
      visibleHouse: [...td.querySelectorAll('.bc-badge.house')].some(vis),
      visibleLimo: [...td.querySelectorAll('.bc-badge.limo')].some(vis),
      orangeBand: /245,\\s*158,\\s*11/.test(shadow) || /0px -3px/.test(shadow),
      boxShadow: shadow,
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      inner: window.innerWidth,
    };
  }
  return {
    lake: cell('06:07','LAKE'),
    limo: cell('06:07','VERTHILL'),
    houseLimo: cell('06:14','LAKE'),
    lake2: cell('11:07','LAKE'),
    lake3: cell('16:07','LAKE'),
  };
})()`;

async function chromiumSection() {
section("Chromium: 모바일 360/390/430 · PC 1280 computed style");
{
  const port = 9360 + Math.floor(Math.random() * 200);
  const payload = publishedPayloadForReader(pubOf(nov1Lake0607HouseDraft("2026-11-01")), "admin");
  const caddyPayload = publishedPayloadForReader(pubOf(nov1Lake0607HouseDraft("2026-11-01")), "caddy");
  let child: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const conn = await connectCdp(port);
    child = conn.child;
    cdp = conn.cdp;
    const pages: Array<{ name: string; w: number; mobile: boolean; shift: ShiftPart; payload: DailyBoardPublishedPayloadV1 }> = [
      { name: "390-1부-admin", w: 390, mobile: true, shift: "1부", payload },
      { name: "360-1부-admin", w: 360, mobile: true, shift: "1부", payload },
      { name: "430-1부-admin", w: 430, mobile: true, shift: "1부", payload },
      { name: "1280-1부-admin", w: 1280, mobile: false, shift: "1부", payload },
      { name: "390-1부-caddy", w: 390, mobile: true, shift: "1부", payload: caddyPayload },
      { name: "390-2부", w: 390, mobile: true, shift: "2부", payload },
      { name: "390-3부", w: 390, mobile: true, shift: "3부", payload },
    ];
    for (const pg of pages) {
      const body = htmlOf(pg.payload, pg.shift);
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0">${body}</body></html>`;
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: pg.w, height: 900, deviceScaleFactor: pg.mobile ? 2 : 1, mobile: pg.mobile,
        screenWidth: pg.w, screenHeight: 900,
      });
      const { frameTree } = await cdp.send("Page.getFrameTree");
      await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
      await delay(250);
      const r = await evaluate<Record<string, Probe>>(cdp, PROBE);
      if (pg.shift === "1부") {
        assert(r.lake.visibleHouse === true, `${pg.name}: 06:07 레이크 하우스 배지 보임`);
        assert(r.limo.visibleLimo === true, `${pg.name}: 06:07 베르힐 리무진 배지 보임`);
        assert(r.limo.orangeBand === false, `${pg.name}: 리무진 칸 주황 하단 띠 없음 (shadow=${r.limo.boxShadow})`);
        assert(r.houseLimo.visibleHouse && r.houseLimo.visibleLimo, `${pg.name}: 하우스+리무진 둘 다 보임`);
        assert(r.houseLimo.orangeBand === false, `${pg.name}: 하우스+리무진 칸에도 주황 띠 없음`);
        assert(r.lake.hscroll === false && r.lake.inner === pg.w, `${pg.name}: 가로 스크롤 없음, 폭 ${pg.w}`);
      }
      if (pg.shift === "2부") {
        assert(r.lake2.visibleHouse === true, `${pg.name}: 11:07 레이크 하우스 보임`);
      }
      if (pg.shift === "3부") {
        assert(r.lake3.visibleHouse === true, `${pg.name}: 16:07 레이크 하우스 보임`);
      }
    }
  } catch (e) {
    assert(false, `Chromium 검증 실패: ${e instanceof Error ? e.message : e}`);
  } finally {
    cdp?.close();
    child?.kill("SIGKILL");
  }
}
}

void chromiumSection().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
