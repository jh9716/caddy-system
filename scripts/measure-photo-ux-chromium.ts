/**
 * Headed Chrome/CDP: notice inline size before/after + 1600 vs 1170/1200 quality.
 * Local only. No Production write.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8796;
const DEBUG_PORT = 9224;
const OUT_DIR = "/opt/cursor/artifacts/image-ux-p2-2";

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
    ].find((bin) => existsSync(bin))
  );
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function noticeCssSlice() {
  const css = readFileSync("src/app/globals.css", "utf8");
  const start = css.indexOf(".notice-photos {");
  const end = css.indexOf(".notice-back {");
  return start >= 0 && end > start ? css.slice(start, end) : "";
}

function pageHtml() {
  const afterCss = noticeCssSlice();
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=390, initial-scale=1" />
<title>photo ux measure</title>
<style>
:root { --vh-border:#d7cfc3; --vh-radius-sm:10px; --vh-ivory-deep:#efe6d6; }
body { margin:0; background:#f6f1e8; font-family:ui-sans-serif,system-ui,sans-serif; color:#1f2937; }
.wrap { width:390px; margin:0 auto; padding:12px 16px 32px; box-sizing:border-box; }
h1 { font-size:16px; margin:0 0 8px; }
h2 { font-size:13px; margin:16px 0 8px; }
.notice-page { max-width:720px; }
.box { margin:0 0 12px; }
img { display:block; }
.after { }
${afterCss}
.before .notice-photos-item {
  display:block; width:100%; aspect-ratio:4/3; padding:0;
  border:1px solid var(--vh-border); border-radius:var(--vh-radius-sm);
  background:var(--vh-ivory-deep); overflow:hidden;
}
.before .notice-photos-item img {
  display:block; width:100%; height:100%; object-fit:contain; opacity:1;
}
.quality img { width:390px; height:auto; image-rendering:auto; }
#out { white-space:pre-wrap; font-size:11px; }
</style>
<div class="wrap">
  <h1>Notice photo UX</h1>
  <h2>Before 4:3 contain</h2>
  <div class="notice-page before" id="before">
    <div class="notice-photos"><div class="notice-photos-list">
      <button type="button" class="notice-photos-item" id="before-item">
        <img id="before-img" class="is-revealed" alt="" />
      </button>
    </div></div>
  </div>
  <h2>After native ratio</h2>
  <div class="notice-page after" id="after">
    <div class="notice-photos"><div class="notice-photos-list">
      <button type="button" class="notice-photos-item" id="after-item">
        <img id="after-img" class="is-revealed" alt="" />
      </button>
    </div></div>
  </div>
  <h2>Quality 390px / DPR3</h2>
  <div class="quality">
    <p>1600</p><img id="q1600" alt="" />
    <p>1200</p><img id="q1200" alt="" />
    <p>1170</p><img id="q1170" alt="" />
  </div>
  <pre id="out">running</pre>
</div>
<script>
function encode(longEdge) {
  const srcW = 1080, srcH = 1920;
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0,0,0,h);
  g.addColorStop(0, "#14532d");
  g.addColorStop(1, "#365314");
  ctx.fillStyle = g;
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle = "#fef3c7";
  ctx.fillRect(Math.round(w*0.08), Math.round(h*0.12), Math.round(w*0.84), Math.round(h*0.28));
  ctx.fillStyle = "#111827";
  ctx.font = "700 " + Math.round(w*0.11) + "px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("VERTHILL", w/2, Math.round(h*0.24));
  ctx.font = "600 " + Math.round(w*0.07) + "px sans-serif";
  ctx.fillText("공지 포스터 글자", w/2, Math.round(h*0.32));
  ctx.fillStyle = "#fefce8";
  ctx.font = "500 " + Math.round(w*0.045) + "px sans-serif";
  ctx.fillText("1부 06:40 집결 / 주차 게이트", w/2, Math.round(h*0.48));
  ctx.fillText("캐디 대기실 게시판 확인", w/2, Math.round(h*0.54));
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) throw new Error("encode failed");
      resolve({ blob, w, h, bytes: blob.size, url: URL.createObjectURL(blob) });
    }, "image/jpeg", 0.8);
  });
}
function box(el) {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}
function painted(img) {
  const r = img.getBoundingClientRect();
  const scale = Math.min(r.width / (img.naturalWidth || 1), r.height / (img.naturalHeight || 1));
  return { w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale) };
}
async function run() {
  const poster = await encode(1600);
  const q1600 = poster;
  const q1200 = await encode(1200);
  const q1170 = await encode(1170);
  const beforeImg = document.getElementById("before-img");
  const afterImg = document.getElementById("after-img");
  beforeImg.src = poster.url;
  afterImg.src = poster.url;
  document.getElementById("q1600").src = q1600.url;
  document.getElementById("q1200").src = q1200.url;
  document.getElementById("q1170").src = q1170.url;
  await Promise.all([beforeImg.decode(), afterImg.decode(),
    document.getElementById("q1600").decode(),
    document.getElementById("q1200").decode(),
    document.getElementById("q1170").decode()]);
  const report = {
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    beforeItem: box(document.getElementById("before-item")),
    beforeImg: box(beforeImg),
    beforePainted: painted(beforeImg),
    afterItem: box(document.getElementById("after-item")),
    afterImg: box(afterImg),
    afterPainted: painted(afterImg),
    natural: { w: afterImg.naturalWidth, h: afterImg.naturalHeight },
    encodes: {
      1600: { w: q1600.w, h: q1600.h, bytes: q1600.bytes },
      1200: { w: q1200.w, h: q1200.h, bytes: q1200.bytes },
      1170: { w: q1170.w, h: q1170.h, bytes: q1170.bytes },
    },
    afterCssHas43: ${JSON.stringify(afterCss)}.includes("aspect-ratio: 4 / 3") || ${JSON.stringify(afterCss)}.includes("aspect-ratio:4 / 3"),
  };
  document.getElementById("out").textContent = JSON.stringify(report, null, 2);
  await fetch("/report", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(report) });
}
run().catch((e) => {
  fetch("/report", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ error: String(e) }) });
});
</script>`;
}

type CdpReply = { id: number; result?: { result?: { value?: unknown }; data?: string } };

async function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp ws failed")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (msg: CdpReply) => void>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as CdpReply;
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  async function send(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    const reply = new Promise<CdpReply>((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  return { ws, send };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let report: Record<string, unknown> | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url || "").startsWith("/report") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        try {
          report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          report = { error: "bad json" };
        }
        send(res, 200, '{"ok":true}', "application/json");
      });
      return;
    }
    send(res, 200, pageHtml(), "text/html; charset=utf-8");
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const bin = chromeBin();
  if (!bin) throw new Error("chrome not found");
  const userData = join(tmpdir(), `photo-ux-${Date.now()}`);
  const child: ChildProcess = spawn(
    bin,
    [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=430,980",
      "about:blank",
    ],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, stdio: "ignore" }
  );

  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 12000) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      await delay(150);
    }
  }
  if (!ready) throw new Error("chrome debug port down");

  const createdRes = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`,
    { method: "PUT" }
  );
  const created = (await createdRes.json()) as { webSocketDebuggerUrl?: string };
  if (!created.webSocketDebuggerUrl) throw new Error("no cdp ws");
  const session = await cdpSession(created.webSocketDebuggerUrl);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 2200,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  const waitFrom = Date.now();
  while (!report && Date.now() - waitFrom < 20000) await delay(100);
  if (!report || report.error) throw new Error(`measure failed: ${JSON.stringify(report)}`);

  async function clipShot(selector: string, name: string, pad = 8) {
    const evaled = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });
    const box = evaled.result?.result?.value as
      | { x: number; y: number; width: number; height: number }
      | null
      | undefined;
    if (!box) return;
    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
        scale: 1,
      },
    });
    if (shot.result?.data) {
      writeFileSync(join(OUT_DIR, name), Buffer.from(String(shot.result.data), "base64"));
    }
  }

  const full = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  if (full.result?.data) {
    writeFileSync(join(OUT_DIR, "notice_inline_before_after.png"), Buffer.from(String(full.result.data), "base64"));
  }
  writeFileSync(join(OUT_DIR, "measure.json"), JSON.stringify(report, null, 2));
  await clipShot("#before", "before_43_letterbox.png");
  await clipShot("#after", "after_full_width_portrait.png");
  await clipShot("#q1600", "quality_1600_390_dpr3.png");
  await clipShot("#q1200", "quality_1200_390_dpr3.png");
  await clipShot("#q1170", "quality_1170_390_dpr3.png");

  session.ws.close();
  try {
    if (child.pid) process.kill(child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
