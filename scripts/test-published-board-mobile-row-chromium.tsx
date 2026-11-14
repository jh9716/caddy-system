/**
 * /board 모바일: 배정 행과 빈타임 행 높이를 동일하게 고정.
 * 실행: npm run test:published-board-mobile-row-chromium
 *
 * 엔진·티시트·PC·인쇄 CSS는 건드리지 않고, PublishedBoardView + publishedBoardCss 만 렌더한다.
 */
import React, { createElement } from "react";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as { React: typeof React }).React = React;

import PublishedBoardView from "../src/components/board/PublishedBoardView";
import { publishedBoardCss } from "../src/components/board/publishedBoardCss";
import { buildPublishedPayloadFromDraft } from "../src/lib/dailyBoardPublished";
import type { DailyBoardDraftPayloadV1 } from "../src/lib/dailyBoardDraft";
import { publishedPayloadForReader } from "../src/lib/publishedBoardPrivacy";
import {
  gappedTimetableDraft,
  nov1Lake0607HouseDraft,
  operatingTimetableDraft,
  richMobileDraft,
} from "./fixtures/boardPrintFixtures";
import type { ShiftPart } from "../src/lib/reservationParser";

const ARTIFACT = "/opt/cursor/artifacts";
const ROW_H = 64;

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

type CdpResult = unknown;
type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<CdpResult>; close: () => void };

function chromePath(): string {
  const c = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  return c.find((p) => existsSync(p)) || "google-chrome";
}

async function connectCdp(port: number): Promise<{ cdp: Cdp; child: ChildProcess }> {
  const userData = mkdtempSync(join(tmpdir(), "pub-row-eq-"));
  const child = spawn(
    chromePath(),
    [
      `--user-data-dir=${userData}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let wsUrl = "";
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await delay(100);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || "";
    } catch {
      /* not yet */
    }
  }
  if (!wsUrl) throw new Error("Chrome DevTools 연결 실패");
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
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
  const r = (await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })) as { exceptionDetails?: unknown; result: { value: T } };
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

type Probe = {
  inner: number;
  hscroll: boolean;
  wrapScroll: boolean;
  rowCount: number;
  heights: number[];
  unique: number[];
  assignedMin: number | null;
  assignedMax: number | null;
  emptyMin: number | null;
  emptyMax: number | null;
  overflowCount: number;
  hiddenLabelCount: number;
  cellHeightSpread: number;
  times: string[];
};

const PROBE = `(() => {
  const rows = [...document.querySelectorAll('.pub-board-root .ops-board-row')];
  const info = rows.map((tr) => {
    const r = tr.getBoundingClientRect();
    const cells = [...tr.children].map((el) => Math.round(el.getBoundingClientRect().height * 10) / 10);
    const assignedCount = tr.querySelectorAll('.bc-cell.assigned').length;
    const emptyCount = tr.querySelectorAll('.bc-cell.empty').length;
    const overflow = [...tr.querySelectorAll('.bc-cell.assigned')].some((td) => td.scrollHeight > td.clientHeight + 2);
    const hidden = [...tr.querySelectorAll('.bc-name,.bc-affil,.bc-badge,.lock-chip,.bc-vacant')].filter((el) => {
      const cr = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const td = el.closest('td');
      if (!td) return false;
      const hideTeamBadge = el.classList.contains('bc-badge') && el.closest('.bc-team');
      if (hideTeamBadge && cs.display === 'none') return false;
      return (cs.display === 'none' && !hideTeamBadge) || cr.height < 2 || cr.width < 2;
    }).length;
    return {
      time: tr.getAttribute('data-board-time'),
      h: Math.round(r.height),
      cells,
      assignedCount,
      emptyCount,
      overflow,
      hidden,
      allEmpty: assignedCount === 0 && emptyCount > 0,
      hasAssigned: assignedCount > 0,
    };
  });
  const heights = info.map((x) => x.h);
  const assigned = info.filter((x) => x.hasAssigned).map((x) => x.h);
  const empty = info.filter((x) => x.allEmpty).map((x) => x.h);
  const wrap = document.querySelector('.ops-board-wrap');
  const cellHs = info.flatMap((x) => x.cells);
  return {
    inner: window.innerWidth,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    wrapScroll: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false,
    rowCount: rows.length,
    heights,
    unique: [...new Set(heights)].sort((a,b)=>a-b),
    assignedMin: assigned.length ? Math.min(...assigned) : null,
    assignedMax: assigned.length ? Math.max(...assigned) : null,
    emptyMin: empty.length ? Math.min(...empty) : null,
    emptyMax: empty.length ? Math.max(...empty) : null,
    overflowCount: info.filter((x) => x.overflow).length,
    hiddenLabelCount: info.reduce((n, x) => n + x.hidden, 0),
    cellHeightSpread: cellHs.length ? Math.max(...cellHs) - Math.min(...cellHs) : 0,
    times: info.map((x) => x.time),
  };
})()`;

async function screenshot(cdp: Cdp, path: string) {
  const r = (await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true })) as {
    data: string;
  };
  writeFileSync(path, Buffer.from(r.data, "base64"));
}

function pubOf(draft: { date: string }) {
  return buildPublishedPayloadFromDraft(draft as unknown as DailyBoardDraftPayloadV1);
}

function pageHtml(payload: ReturnType<typeof pubOf>, shift: ShiftPart) {
  const body = renderToStaticMarkup(createElement(PublishedBoardView, { payload, shift }));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html,body{margin:0;background:#fff;font-family:system-ui,sans-serif}</style></head>
    <body>${body}</body></html>`;
}

section("원인 고정: CSS 선택자 범위");
{
  const css = publishedBoardCss;
  const src = readFileSync("src/components/board/publishedBoardCss.ts", "utf8");
  const mobile = css.slice(css.lastIndexOf("@media (max-width: 480px)"));
  assert(/--pub-board-row-h:\s*64px/.test(mobile), "모바일 --pub-board-row-h: 64px");
  assert(
    /\.pub-board-root \.ops-board-row > \.bc-time/.test(mobile) &&
      /\.pub-board-root \.ops-board-row > \.bc-cell/.test(mobile),
    "행 높이 규칙은 .pub-board-root 로 범위 제한"
  );
  assert(/max-height:\s*var\(--pub-board-row-h\)/.test(mobile), "max-height 로 내용에 따른 확장 차단");
  assert(/\.pub-board-root \.bc-slot/.test(mobile), "슬롯 높이도 .pub-board-root 범위");
  assert(!/text-overflow:\s*ellipsis/.test(css), "이름 말줄임 없음");
  const manage = readFileSync("src/app/manage/assignments/page.tsx", "utf8");
  assert(!/--pub-board-row-h/.test(manage), "/manage/assignments 에 모바일 행 높이 변수 없음");
  const printCss = readFileSync("src/components/board/assignmentBoardPrintCss.ts", "utf8");
  assert(!/--pub-board-row-h/.test(printCss), "인쇄 CSS 미변경");
  assert(!/--pub-board-row-h/.test(src.slice(0, src.lastIndexOf("@media (max-width: 480px)"))), "PC 블록에 행 높이 변수 없음");
}

async function main() {
  mkdirSync(ARTIFACT, { recursive: true });
  const port = 9410 + Math.floor(Math.random() * 200);
  const { cdp, child } = await connectCdp(port);
  const operating = operatingTimetableDraft();
  const gapped = gappedTimetableDraft();
  const house = nov1Lake0607HouseDraft("2026-11-01");
  const rich = richMobileDraft();
  const pages: Array<{
    name: string;
    w: number;
    mobile: boolean;
    shift: ShiftPart;
    draft: ReturnType<typeof operatingTimetableDraft>;
    role: "admin" | "caddy";
    expectEmpty: boolean;
    shot: boolean;
  }> = [
    { name: "operating-1-390", w: 390, mobile: true, shift: "1부", draft: operating, role: "admin", expectEmpty: false, shot: true },
    { name: "operating-2-390", w: 390, mobile: true, shift: "2부", draft: operating, role: "admin", expectEmpty: false, shot: true },
    { name: "operating-3-360", w: 360, mobile: true, shift: "3부", draft: operating, role: "admin", expectEmpty: true, shot: true },
    { name: "operating-3-390", w: 390, mobile: true, shift: "3부", draft: operating, role: "admin", expectEmpty: true, shot: true },
    { name: "operating-3-430", w: 430, mobile: true, shift: "3부", draft: operating, role: "admin", expectEmpty: true, shot: true },
    { name: "gapped-1-390", w: 390, mobile: true, shift: "1부", draft: gapped, role: "admin", expectEmpty: true, shot: true },
    { name: "gapped-2-390", w: 390, mobile: true, shift: "2부", draft: gapped, role: "admin", expectEmpty: true, shot: false },
    { name: "gapped-3-390", w: 390, mobile: true, shift: "3부", draft: gapped, role: "admin", expectEmpty: true, shot: false },
    { name: "house-1-360", w: 360, mobile: true, shift: "1부", draft: house, role: "admin", expectEmpty: false, shot: true },
    { name: "house-1-390", w: 390, mobile: true, shift: "1부", draft: house, role: "admin", expectEmpty: false, shot: true },
    { name: "house-1-430", w: 430, mobile: true, shift: "1부", draft: house, role: "admin", expectEmpty: false, shot: true },
    { name: "house-1-390-caddy", w: 390, mobile: true, shift: "1부", draft: house, role: "caddy", expectEmpty: false, shot: false },
    { name: "rich-1-360", w: 360, mobile: true, shift: "1부", draft: rich, role: "admin", expectEmpty: false, shot: true },
    { name: "rich-1-390", w: 390, mobile: true, shift: "1부", draft: rich, role: "admin", expectEmpty: false, shot: false },
    { name: "pc-operating-3-1280", w: 1280, mobile: false, shift: "3부", draft: operating, role: "admin", expectEmpty: true, shot: true },
  ];
  const reports: Record<string, Probe> = {};
  try {
    section("Chromium: 360/390/430 · 1·2·3부 행 높이");
    for (const pg of pages) {
      const payload = publishedPayloadForReader(pubOf(pg.draft), pg.role);
      const html = pageHtml(payload, pg.shift);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: pg.w,
        height: 1100,
        deviceScaleFactor: pg.mobile ? 2 : 1,
        mobile: pg.mobile,
        screenWidth: pg.w,
        screenHeight: 1100,
      });
      const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
      await delay(180);
      const r = await evaluate<Probe>(cdp, PROBE);
      reports[pg.name] = r;
      if (pg.shot) {
        await screenshot(cdp, join(ARTIFACT, `after-${pg.name}.png`));
      }

      if (pg.mobile) {
        assert(r.rowCount >= 2, `${pg.name}: 시간 행 존재 (${r.rowCount})`);
        const spread = Math.max(...r.heights) - Math.min(...r.heights);
        assert(spread <= 1, `${pg.name}: 모든 시간 행 높이 동일 (unique=${r.unique.join(",")})`);
        assert(
          r.heights.every((h) => Math.abs(h - ROW_H) <= 1),
          `${pg.name}: 공통 높이 ${ROW_H}px (got ${r.unique.join(",")})`
        );
        assert(r.cellHeightSpread <= 1, `${pg.name}: 같은 행의 시간·4코스 셀 높이 공유 (spread=${r.cellHeightSpread})`);
        if (pg.expectEmpty) {
          assert(r.emptyMin != null && r.assignedMin != null, `${pg.name}: 배정 행과 빈타임 행 모두 존재`);
          assert(
            r.emptyMin != null &&
              r.assignedMin != null &&
              Math.abs(r.emptyMin - r.assignedMin) <= 1 &&
              Math.abs((r.emptyMax ?? 0) - (r.assignedMax ?? 0)) <= 1,
            `${pg.name}: 빈타임=${r.emptyMin}–${r.emptyMax} 배정=${r.assignedMin}–${r.assignedMax}`
          );
        }
        assert(r.overflowCount === 0, `${pg.name}: 이름·조·배지 셀 밖으로 잘리지 않음`);
        assert(r.hiddenLabelCount === 0, `${pg.name}: 캐디명·조·배지 렌더 높이 유지`);
        assert(r.hscroll === false && r.wrapScroll === false && r.inner === pg.w, `${pg.name}: 가로 스크롤 없음`);
      } else {
        assert(r.inner === 1280, `${pg.name}: PC 폭`);
        assert(
          r.emptyMin != null && r.assignedMin != null && r.emptyMin < r.assignedMin - 8,
          `${pg.name}: PC는 빈타임 행이 배정 행보다 낮음(모바일 고정 높이 미적용) empty=${r.emptyMin} assigned=${r.assignedMin}`
        );
        assert(!r.heights.every((h) => Math.abs(h - ROW_H) <= 1), `${pg.name}: PC 행이 모바일 64px로 고정되지 않음`);
      }
    }
  } catch (e) {
    assert(false, `Chromium 검증 실패: ${e instanceof Error ? e.message : e}`);
  } finally {
    cdp.close();
    child.kill("SIGKILL");
  }

  writeFileSync(join(ARTIFACT, "after-row-heights.json"), JSON.stringify(reports, null, 2));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
