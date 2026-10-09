/**
 * Local Chrome encode benchmark for Chat Photo Phase 10.
 * No Production write. Numeric timings only.
 */
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 8798;
const DEBUG_PORT = 9226;
const OUT = "/opt/cursor/artifacts/chat-photo-phase10-encode.json";

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find(
      (bin) => existsSync(bin)
    )
  );
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function pageHtml() {
  return `<!doctype html>
<meta charset="utf-8" />
<title>chat photo encode bench</title>
<pre id="out">running</pre>
<script>
async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode"))), type, quality);
  });
}
async function makeSource(width, height) {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#335577";
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = i % 2 ? "#e8d7b0" : "#2a6f4f";
    ctx.fillRect((i * 47) % width, (i * 31) % height, 180, 120);
  }
  return c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}
async function encodeOnce(bitmap, mime, quality, longEdge) {
  const scale = Math.min(1, longEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  const draw0 = performance.now();
  ctx.drawImage(bitmap, 0, 0, w, h);
  const drawMs = performance.now() - draw0;
  const enc0 = performance.now();
  const blob = await canvasToBlob(c, mime, quality);
  return { drawMs, encodeMs: performance.now() - enc0, bytes: blob.size, w, h, mime: blob.type || mime };
}
async function run() {
  const src = await makeSource(4000, 3000);
  const dec0 = performance.now();
  const bitmap = await createImageBitmap(src, { imageOrientation: "from-image" });
  const decodeMs = performance.now() - dec0;
  const jpeg1 = await encodeOnce(bitmap, "image/jpeg", 0.82, 1600);
  const webp1 = await encodeOnce(bitmap, "image/webp", 0.82, 1600);
  const jpeg2 = await encodeOnce(bitmap, "image/jpeg", 0.7, 1600);
  const webp2 = await encodeOnce(bitmap, "image/webp", 0.7, 1600);
  const out = {
    sourceBytes: src.size,
    decodeMs: Math.round(decodeMs),
    jpeg1: { ...jpeg1, drawMs: Math.round(jpeg1.drawMs), encodeMs: Math.round(jpeg1.encodeMs) },
    webp1: { ...webp1, drawMs: Math.round(webp1.drawMs), encodeMs: Math.round(webp1.encodeMs) },
    jpeg2: { ...jpeg2, drawMs: Math.round(jpeg2.drawMs), encodeMs: Math.round(jpeg2.encodeMs) },
    webp2: { ...webp2, drawMs: Math.round(webp2.drawMs), encodeMs: Math.round(webp2.encodeMs) },
    oldPathMs: Math.round(decodeMs + webp1.drawMs + webp1.encodeMs + webp2.encodeMs),
    newPathMs: Math.round(decodeMs + jpeg1.drawMs + jpeg1.encodeMs),
  };
  document.getElementById("out").textContent = JSON.stringify(out);
  window.__BENCH__ = out;
}
run().catch((e) => {
  document.getElementById("out").textContent = JSON.stringify({ error: String(e && e.message || e) });
});
</script>`;
}

async function cdp(method: string, params: Record<string, unknown> = {}) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = list.find((row: { type?: string; webSocketDebuggerUrl?: string }) => row.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error("no chrome target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const id = 1;
  const result = await new Promise<unknown>((resolve, reject) => {
    ws.addEventListener("message", (ev) => {
      const row = JSON.parse(String(ev.data));
      if (row.id === id) resolve(row.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 20000);
  });
  ws.close();
  return result;
}

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error("chrome not found");
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") return send(res, 200, pageHtml(), "text/html; charset=utf-8");
    send(res, 404, "no", "text/plain");
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  const profile = join(tmpdir(), `chat-photo-encode-${Date.now()}`);
  mkdirSync(profile, { recursive: true });
  const chrome: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: "ignore" }
  );
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        break;
      } catch {
        await delay(150);
      }
    }
    await delay(800);
    let bench: Record<string, unknown> | null = null;
    for (let i = 0; i < 40; i++) {
      const evaled = (await cdp("Runtime.evaluate", {
        expression: "window.__BENCH__ ? JSON.stringify(window.__BENCH__) : document.getElementById('out')?.textContent",
        returnByValue: true,
      })) as { result?: { value?: string } };
      const raw = evaled?.result?.value || "";
      if (raw && raw !== "running" && raw.startsWith("{")) {
        bench = JSON.parse(raw);
        if (bench && !("error" in bench && Object.keys(bench).length === 1)) break;
      }
      await delay(200);
    }
    if (!bench || bench.error) throw new Error(`bench failed ${JSON.stringify(bench)}`);
    writeFileSync(OUT, JSON.stringify(bench, null, 2));
    console.log(JSON.stringify(bench, null, 2));
  } finally {
    chrome.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
