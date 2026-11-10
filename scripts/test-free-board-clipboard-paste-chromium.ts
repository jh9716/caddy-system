/**
 * Wide Excel placement table through the real free-board photo prepare.
 * Confirms a PNG above 2560px and under 3MB is kept, so small cell text
 * is not JPEG-scaled. Local Chrome only. No database.
 * 실행: npm run test:free-board-clipboard-paste-chromium
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";

const PORT = 8798;
const DEBUG_PORT = 9228;
const OUT_DIR = "/opt/cursor/artifacts";

const MODULES = [
  "offRequestDomain",
  "pendingLoad",
  "safeReturnPath",
  "clientResourceCache",
  "memberSessionRedirect",
  "courseReportPhotoConstants",
  "courseReportPhotoClient",
  "freeBoardConstants",
  "freeBoardPhotoClient",
  "noticeClipboardPaste",
  "noticeExcelTableImage",
];

function wideExcelHtml() {
  const cols = 22;
  const colTags = Array.from({ length: cols }, () => "<col width=80 style='width:60pt'>").join("");
  const header = Array.from({ length: cols }, (_, i) => `<td class=xl65>${i + 1}</td>`).join("");
  const names = Array.from(
    { length: cols },
    (_, i) => `<td class=xl66>${i === 0 ? "김A1" : "가"}</td>`
  ).join("");
  const extra = Array.from({ length: 6 }, (_, row) => {
    const cells = Array.from({ length: cols }, (_, i) => `<td class=xl66>${row + 1}-${i + 1}</td>`).join("");
    return `<tr height=18 style='height:13.5pt'>${cells}</tr>`;
  }).join("");
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta name=ProgId content=Excel.Sheet>
<meta name=Generator content="Microsoft Excel 16">
<style>
td { color:black; font-size:8.0pt; font-weight:400; font-family:"Noto Serif KR","Malgun Gothic",monospace;
 text-align:center; vertical-align:middle; border:.5pt solid #7F7F7F; white-space:nowrap; }
.xl65 { color:white; font-size:8.0pt; font-weight:700; background:#1F4E79; border:.5pt solid windowtext; }
.xl66 { font-size:8.0pt; background:#FFFFFF; }
</style>
</head>
<body>
<table>
${colTags}
<tr height=18 style='height:13.5pt'>${header}</tr>
<tr height=18 style='height:13.5pt'>${names}</tr>
${extra}
</table>
</body>
</html>`;
}

function chromeBin() {
  return (
    process.env.CHROME_BIN ||
    ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((bin) =>
      existsSync(bin)
    )
  );
}

function transpile(rel: string) {
  const source = readFileSync(rel, "utf8");
  return ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      fileName: rel,
    })
    .outputText.replace(/from\s+["']@\/lib\/([^"']+)["']/g, 'from "/m/$1.js"');
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function pageHtml() {
  return `<!doctype html>
<meta charset="utf-8" />
<title>free-board excel paste</title>
<style>
  body { margin: 16px; background: #efe6d6; color: #1c1915; font-family: "Noto Serif KR", sans-serif; }
  .compare { width: 420px; background: #fff; padding: 12px; box-sizing: border-box; }
  h2 { margin: 0 0 8px; font-size: 14px; }
  canvas { width: 100%; height: auto; display: block; background: #fff; border: 1px solid #ddd; }
  p { margin: 10px 0 4px; font-size: 12px; }
  #status { width: 420px; font-size: 12px; white-space: pre-wrap; }
</style>
<link rel="stylesheet" href="/noto400.css" />
<link rel="stylesheet" href="/noto700.css" />
<div class="compare" id="compare">
  <h2>가배치표 엑셀 붙여넣기</h2>
  <p>PNG 유지 (첨부되는 이미지)</p>
  <canvas id="pngCrop" width="396" height="96"></canvas>
  <p>2560 JPEG로 줄이면</p>
  <canvas id="jpegCrop" width="396" height="96"></canvas>
</div>
<pre id="status"></pre>
<script type="module">
import { excelClipboardHtmlToNoticePhoto, parseExcelClipboardHtml, renderExcelTableCanvas } from "/m/noticeExcelTableImage.js";
import { prepareFreeBoardPhoto, freeBoardKeepsOriginalPng } from "/m/freeBoardPhotoClient.js";
import { FREE_BOARD_PHOTO_LONG_EDGE, FREE_BOARD_PHOTO_MAX_BYTES } from "/m/freeBoardConstants.js";

const html = ${JSON.stringify(wideExcelHtml())};
function inkBox(ctx, x, y, w, h) {
  const data = ctx.getImageData(x, y, w, h).data;
  let ink = 0;
  let darkest = 255;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(data[i], data[i + 1], data[i + 2]);
    if (v < darkest) darkest = v;
    if (v < 48) ink += 1;
  }
  return { ink, darkest };
}
async function drawBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas;
}
function paintCrop(dest, source, sx, sy, sw, sh, smooth) {
  const ctx = dest.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, dest.width, dest.height);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dest.width, dest.height);
}
try {
  await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 4000))]);
  await document.fonts.load('400 16px "Noto Serif KR"', "김A1 가").catch(() => undefined);
  await document.fonts.load('700 16px "Noto Serif KR"', "123456789").catch(() => undefined);
  const model = parseExcelClipboardHtml(html);
  const canvas = renderExcelTableCanvas(model);
  const file = await excelClipboardHtmlToNoticePhoto(html);
  const prepared = await prepareFreeBoardPhoto(file);
  const scale = Number(canvas.dataset.excelScale || "1");
  const rows = (canvas.dataset.excelRows || "").split(",").map(Number);
  const cols = (canvas.dataset.excelCols || "").split(",").map(Number);
  const cellX = 6;
  const cellY = rows[0] + 3;
  const cellW = Math.max(8, cols[0] - 12);
  const cellH = Math.max(8, rows[1] - 6);
  const preparedCanvas = await drawBlob(prepared);
  const keeps = freeBoardKeepsOriginalPng({
    mime: file.type,
    width: canvas.width,
    height: canvas.height,
    size: file.size,
  });
  const srcCtx = canvas.getContext("2d");
  const pngCtx = preparedCanvas.getContext("2d");
  const sourceInk = inkBox(
    srcCtx,
    Math.round(cellX * scale),
    Math.round(cellY * scale),
    Math.round(cellW * scale),
    Math.round(cellH * scale)
  );
  const pngInk = inkBox(
    pngCtx,
    Math.round(cellX * scale),
    Math.round(cellY * scale),
    Math.round(cellW * scale),
    Math.round(cellH * scale)
  );
  const jpegScale = Math.min(1, FREE_BOARD_PHOTO_LONG_EDGE / Math.max(canvas.width, canvas.height));
  const jpegCanvas = document.createElement("canvas");
  jpegCanvas.width = Math.max(1, Math.round(canvas.width * jpegScale));
  jpegCanvas.height = Math.max(1, Math.round(canvas.height * jpegScale));
  const jpegCtx = jpegCanvas.getContext("2d");
  jpegCtx.fillStyle = "#ffffff";
  jpegCtx.fillRect(0, 0, jpegCanvas.width, jpegCanvas.height);
  jpegCtx.drawImage(canvas, 0, 0, jpegCanvas.width, jpegCanvas.height);
  const jpegBlob = await new Promise((resolve, reject) => {
    jpegCanvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("jpeg failed"))), "image/jpeg", 0.9);
  });
  const jpegDrawn = await drawBlob(jpegBlob);
  const jpegInk = inkBox(
    jpegDrawn.getContext("2d"),
    Math.round(cellX * scale * jpegScale),
    Math.round(cellY * scale * jpegScale),
    Math.max(1, Math.round(cellW * scale * jpegScale)),
    Math.max(1, Math.round(cellH * scale * jpegScale))
  );
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const preparedBytes = new Uint8Array(await prepared.arrayBuffer());
  let sameBytes = fileBytes.length === preparedBytes.length;
  for (let i = 0; sameBytes && i < fileBytes.length; i++) {
    if (fileBytes[i] !== preparedBytes[i]) sameBytes = false;
  }
  paintCrop(
    document.getElementById("pngCrop"),
    preparedCanvas,
    Math.round(cellX * scale),
    Math.round((rows[0] - 2) * scale),
    Math.round(cols[0] * 2 * scale),
    Math.round((rows[0] + rows[1]) * scale),
    false
  );
  paintCrop(
    document.getElementById("jpegCrop"),
    jpegDrawn,
    Math.round(cellX * scale * jpegScale),
    Math.round((rows[0] - 2) * scale * jpegScale),
    Math.round(cols[0] * 2 * scale * jpegScale),
    Math.round((rows[0] + rows[1]) * scale * jpegScale),
    true
  );
  const report = {
    width: canvas.width,
    height: canvas.height,
    scale,
    fileType: file.type,
    fileSize: file.size,
    preparedType: prepared.type,
    preparedSize: prepared.size,
    sameBytes,
    keeps,
    longEdgeLimit: FREE_BOARD_PHOTO_LONG_EDGE,
    maxBytes: FREE_BOARD_PHOTO_MAX_BYTES,
    sourceInk,
    pngInk,
    jpegInk,
  };
  document.getElementById("status").textContent = JSON.stringify(report, null, 2);
  await fetch("/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  document.getElementById("status").textContent = message;
  await fetch("/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message }),
  });
}
</script>`;
}

type CdpReply = {
  id?: number;
  result?: { result?: { value?: unknown }; data?: string };
  error?: { message?: string };
};

async function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("cdp websocket failed")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (msg: CdpReply) => void>();
  const logs: string[] = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as CdpReply & {
      method?: string;
      params?: {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
        args?: Array<{ value?: unknown; description?: string }>;
      };
    };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      logs.push(
        msg.params?.exceptionDetails?.exception?.description ||
          msg.params?.exceptionDetails?.text ||
          "exception"
      );
    } else if (msg.method === "Runtime.consoleAPICalled") {
      logs.push((msg.params?.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  async function send(method: string, params?: Record<string, unknown>) {
    const id = nextId++;
    const reply = new Promise<CdpReply>((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  return { ws, send, logs };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const scripts = new Map(MODULES.map((name) => [name, transpile(`src/lib/${name}.ts`)]));
  const fontRoot = "node_modules/@fontsource/noto-serif-kr";
  const noto400 = readFileSync(`${fontRoot}/400.css`, "utf8").replaceAll("url(./files/", "url(/fonts/");
  const noto700 = readFileSync(`${fontRoot}/700.css`, "utf8").replaceAll("url(./files/", "url(/fonts/");
  let report: Record<string, unknown> | null = null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/report" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
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
    const mod = url.pathname.match(/^\/m\/([A-Za-z0-9]+)\.js$/);
    if (mod && scripts.has(mod[1])) {
      send(res, 200, scripts.get(mod[1])!, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/noto400.css") {
      send(res, 200, noto400, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname === "/noto700.css") {
      send(res, 200, noto700, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname.startsWith("/fonts/")) {
      const name = url.pathname.slice("/fonts/".length);
      const file = join(fontRoot, "files", name);
      if (name.includes("..") || name.includes("/") || !existsSync(file)) {
        send(res, 404, "missing font", "text/plain");
        return;
      }
      send(res, 200, readFileSync(file), name.endsWith(".woff2") ? "font/woff2" : "font/woff");
      return;
    }
    send(res, 200, pageHtml(), "text/html; charset=utf-8");
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

  const bin = chromeBin();
  if (!bin) throw new Error("chrome not found");
  const userData = join(tmpdir(), `freeboard-paste-${Date.now()}`);
  const child: ChildProcess = spawn(
    bin,
    [
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=520,720",
      "about:blank",
    ],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" }, stdio: "ignore" }
  );

  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15000) {
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
    if (!ready) throw new Error("chrome debug port did not open");

    const createdRes = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
      method: "PUT",
    });
    const createdText = await createdRes.text();
    const created = JSON.parse(createdText) as { webSocketDebuggerUrl?: string };
    if (!created.webSocketDebuggerUrl) {
      throw new Error(`no cdp websocket: ${createdRes.status} ${createdText.slice(0, 300)}`);
    }
    const session = await cdpSession(created.webSocketDebuggerUrl);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    const waitFrom = Date.now();
    while (!report && Date.now() - waitFrom < 25000) await delay(100);
    const finished = report as Record<string, unknown> | null;
    if (!finished) {
      const evaled = await session.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({ href: location.href, text: document.body ? document.body.innerText.slice(0, 800) : '' })",
        returnByValue: true,
      });
      throw new Error(
        `render timed out: ${JSON.stringify(evaled.result?.result?.value)} logs=${session.logs.join(" | ")}`
      );
    }
    if (finished.error) throw new Error(`render failed: ${JSON.stringify(finished)}`);

    const boxEval = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector("#compare");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });
    const box = boxEval.result?.result?.value as
      | { x: number; y: number; width: number; height: number }
      | null
      | undefined;
    const shot = await session.send(
      "Page.captureScreenshot",
      box
        ? {
            format: "png",
            fromSurface: true,
            clip: {
              x: Math.max(0, box.x - 8),
              y: Math.max(0, box.y - 8),
              width: box.width + 16,
              height: box.height + 16,
              scale: 1,
            },
          }
        : { format: "png", fromSurface: true }
    );
    if (shot.result?.data) {
      writeFileSync(join(OUT_DIR, "freeboard-excel-paste.png"), Buffer.from(String(shot.result.data), "base64"));
    }
    writeFileSync(join(OUT_DIR, "freeboard-excel-paste.json"), JSON.stringify(finished, null, 2));
    session.ws.close();

    const width = Number(finished.width);
    const height = Number(finished.height);
    const sourceInk = finished.sourceInk as { ink: number; darkest: number };
    const pngInk = finished.pngInk as { ink: number; darkest: number };
    const jpegInk = finished.jpegInk as { ink: number; darkest: number };
    const problems: string[] = [];
    if (!(width > 2560 && width <= 4096)) problems.push(`width ${width}`);
    if (!(height > 0 && height <= 4096)) problems.push(`height ${height}`);
    if (finished.fileType !== "image/png") problems.push(`file ${String(finished.fileType)}`);
    if (!(Number(finished.fileSize) > 1000 && Number(finished.fileSize) <= 3 * 1024 * 1024)) {
      problems.push(`size ${String(finished.fileSize)}`);
    }
    if (finished.keeps !== true) problems.push("passthrough decision");
    if (finished.preparedType !== "image/png") problems.push(`prepared ${String(finished.preparedType)}`);
    if (finished.sameBytes !== true) problems.push("prepared bytes differ from the excel PNG");
    if (!sourceInk || sourceInk.ink < 30 || sourceInk.darkest > 16) problems.push(`source ink ${JSON.stringify(sourceInk)}`);
    if (!pngInk || pngInk.ink < sourceInk.ink * 0.95 || pngInk.darkest > 16) {
      problems.push(`png ink ${JSON.stringify(pngInk)}`);
    }
    if (!pngInk || !jpegInk || jpegInk.ink >= pngInk.ink * 0.7) {
      problems.push(`jpeg still as sharp as png ${JSON.stringify(jpegInk)}`);
    }
    console.log(JSON.stringify(finished, null, 2));
    if (problems.length) throw new Error(`free-board excel paste mismatch: ${problems.join("; ")}`);
    console.log("free-board excel PNG kept its pixels");
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
