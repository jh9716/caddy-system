/**
 * Chromium 390px: 배치표 컬럼 헤더 sticky 경계.
 * Playwright 미사용 — 저장소에 Playwright가 없어 기존 Chrome headless 패턴을 쓴다.
 * Samsung Internet은 이 VM에서 실행하지 않음.
 *
 * 실행: npm run test:assignment-board-sticky-chromium
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8799;

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

type Box = { top: number; bottom: number; height: number };
type Snapshot = {
  bar: Box;
  tabs: Box;
  head: Box;
  first: Box;
  last: Box;
  publish: Box;
  wrapOverflowY: string;
  stackPosition: string;
  headPosition: string;
  headTop: string;
};
type Report = {
  rest: Snapshot;
  stuck: Snapshot;
  pastBoard: Snapshot;
  reverse: Snapshot;
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

function htmlPage(): string {
  const rows = Array.from({ length: 24 }, (_, i) => {
    const mark = i === 0 ? ' data-row="first"' : i === 23 ? ' data-row="last"' : "";
    return `<tr class="ops-board-row"${mark}><th class="bc-time">16:${String(i).padStart(2, "0")}</th><td class="bc-cell">R${i}</td><td class="bc-cell"></td><td class="bc-cell"></td><td class="bc-cell"></td></tr>`;
  }).join("");
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=390, initial-scale=1" />
<title>board sticky geometry</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: sans-serif; }
  .vh-mobile-bar {
    position: sticky; top: 0; z-index: 30;
    height: 53px; display: flex; align-items: center; justify-content: center;
    background: #fff8ee; border-bottom: 1px solid #ddd; font-weight: 800;
  }
  .ops-root { --ops-board-sticky-top: 53px; padding: 8px 8px 80px; }
  .ops-sticky-stack { position: relative; z-index: auto; display: grid; gap: 8px; padding: 6px 0 0; background: #f8fafc; }
  .ops-tabs { min-height: 44px; background: #e2e8f0; display: flex; align-items: center; padding: 8px; }
  .ops-board-scope { position: relative; transform: translateY(0); }
  .ops-board { width: 100%; table-layout: fixed; border-collapse: collapse; }
  .ops-col-time { width: 52px; }
  .ops-board-head-bar {
    position: sticky; top: var(--ops-board-sticky-top, 0px); z-index: 4;
    background: #0f172a;
  }
  .ops-board-head th {
    position: sticky; top: var(--ops-board-sticky-top, 0px); z-index: 4;
    background: #0f172a; color: #fff; padding: 8px; font-weight: 800;
    border: 1px solid #334155;
  }
  .ops-board-wrap { overflow-x: clip; overflow-y: visible; }
  .ops-board-row td, .ops-board-row th { height: 40px; border: 1px solid #e2e8f0; text-align: center; }
  .bc-time { background: #f8fafc; }
  .ops-publish { margin-top: 16px; padding: 24px; border: 1px solid #e5e7eb; min-height: 180px; background: #fff; }
  .ops-notify { padding: 40px; background: #f1f5f9; min-height: 220px; }
</style>
</head>
<body>
  <header class="vh-mobile-bar">VERTHILL</header>
  <div class="ops-root">
    <div style="height:120px">설정 패널</div>
    <div class="ops-sticky-stack" data-ops-sticky-stack="1">
      <div class="ops-tabs">1부 2부 3부 · 엑셀편집 · 이미지 · 엑셀 · 스페어</div>
    </div>
    <div class="ops-board-scope has-sticky-head" data-ops-board-scope="1">
      <div class="ops-board-wrap">
        <table class="ops-board">
          <colgroup><col class="ops-col-time" /><col /><col /><col /><col /></colgroup>
          <thead class="ops-board-head-bar" data-ops-board-head="1">
            <tr class="ops-board-head"><th>시간</th><th>베</th><th>스</th><th>오</th><th>레</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <section class="ops-publish" data-ops-publish="1">운영 반영</section>
    <div class="ops-notify">배치표 알림</div>
    <div style="height:900px">하단 여백</div>
  </div>
<script>
function box(el) {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, height: r.height };
}
function snap() {
  const wrap = document.querySelector(".ops-board-wrap");
  const stack = document.querySelector("[data-ops-sticky-stack]");
  const head = document.querySelector("[data-ops-board-head]");
  return {
    bar: box(document.querySelector(".vh-mobile-bar")),
    tabs: box(stack),
    head: box(head),
    first: box(document.querySelector("[data-row=first]")),
    last: box(document.querySelector("[data-row=last]")),
    publish: box(document.querySelector("[data-ops-publish]")),
    wrapOverflowY: getComputedStyle(wrap).overflowY,
    stackPosition: getComputedStyle(stack).position,
    headPosition: getComputedStyle(head).position,
    headTop: getComputedStyle(head).top,
  };
}
function waitFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
async function run() {
  const rest = snap();
  const headEl = document.querySelector("[data-ops-board-head]");
  const stickyTop = 53;
  const y = headEl.getBoundingClientRect().top + window.scrollY - stickyTop + 60;
  window.scrollTo(0, Math.max(0, y));
  await waitFrame();
  const stuck = snap();
  const lastEl = document.querySelector("[data-row=last]");
  lastEl.scrollIntoView({ block: "end" });
  await waitFrame();
  let guard = 0;
  while (lastEl.getBoundingClientRect().bottom > 40 && guard < 40) {
    window.scrollBy(0, 80);
    await waitFrame();
    guard += 1;
  }
  const pastBoard = snap();
  window.scrollTo(0, 0);
  await waitFrame();
  const reverse = snap();
  const report = { rest, stuck, pastBoard, reverse };
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
  document.body.setAttribute("data-done", "1");
}
run().catch((e) => {
  fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: String(e) }) });
});
</script>
</body></html>`;
}

async function main() {
  let report: Report | { error?: string } | null = null;
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
    send(res, 200, htmlPage(), "text/html; charset=utf-8");
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const userData = mkdtempSync(join(tmpdir(), "board-sticky-"));
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
        "--disable-sync",
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
      throw new Error(`Chromium sticky report missing: ${JSON.stringify(report)}`);
    }
    const r = report as Report;
    assert(r.rest.stackPosition === "relative" || r.rest.stackPosition === "static", "탭 스택 sticky 아님");
    assert(r.rest.headPosition === "sticky", "컬럼 헤더 sticky");
    assert(r.rest.wrapOverflowY === "visible" || r.rest.wrapOverflowY === "clip", "wrap 세로 내부 스크롤 없음");
    assert(r.rest.first.top + 0.5 >= r.rest.head.bottom, "초기: 첫 행이 헤더에 가려지지 않음");
    assert(r.rest.head.top + 0.5 >= r.rest.bar.bottom, "초기: 헤더가 앱 바와 겹치지 않음");

    assert(Math.abs(r.stuck.head.top - r.stuck.bar.bottom) <= 2 || r.stuck.head.top >= r.stuck.bar.bottom - 1, "스크롤 중 헤더가 앱 바 아래");
    assert(r.stuck.head.top + 0.5 >= r.stuck.bar.bottom, "스크롤 중 앱 바와 헤더 겹침 없음");
    assert(r.stuck.head.height > 8, "스크롤 중 컬럼 헤더가 보임");
    assert(r.stuck.tabs.top < r.stuck.bar.top - 8 || r.stuck.tabs.bottom <= r.stuck.head.top + 1, "탭은 페이지와 함께 올라감");

    assert(r.pastBoard.publish.top < 500, "운영 반영이 화면에 들어옴");
    assert(r.pastBoard.last.bottom < 40, "마지막 행이 상단을 지나감");
    assert(
      r.pastBoard.head.bottom < r.pastBoard.bar.bottom + 8 || r.pastBoard.head.top > 120,
      "배치표가 끝나면 컬럼 헤더가 상단에 남지 않음"
    );

    assert(r.reverse.first.top + 0.5 >= r.reverse.head.bottom, "역스크롤 후 첫 행이 다시 보임");
    assert(r.reverse.head.top + 0.5 >= r.reverse.bar.bottom, "역스크롤 후 앱 바와 겹치지 않음");
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
