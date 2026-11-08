/**
 * Local wrangler: `{type:"authorized"}` before history on new WS and resume.
 * Measures frame arrival — does not delay history. No Production Worker/DB.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = "/opt/cursor/artifacts/authorized-frame-timing.json";

function parseJson(event) {
  return JSON.parse(String(event.data));
}

function waitMessage(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timeout waiting for websocket message"));
    }, timeoutMs);
    function onMessage(event) {
      const data = parseJson(event);
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    }
    ws.addEventListener("message", onMessage);
  });
}

function waitClose(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const done = (ev) => {
      clearTimeout(timer);
      resolve(ev);
    };
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve({ code: 4008, reason: "already-closing" });
      return;
    }
    const timer = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (ev) => done(ev));
  });
}

function collectFromConnect(port, room, token) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
    const timer = setTimeout(() => reject(new Error(`ws open timeout room=${room}`)), 8000);
    ws.addEventListener("message", (event) => {
      frames.push({ t: performance.now(), data: parseJson(event) });
    });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ ws, frames });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`ws error room=${room}`));
    });
  });
}

test("source: authorized has no PII and is never on deny", () => {
  const index = readFileSync(join(root, "../src/index.ts"), "utf8");
  const proto = readFileSync(join(root, "../src/protocol.ts"), "utf8");
  const send = index.slice(index.indexOf("function sendAuthorized"), index.indexOf("function directoryStub"));
  assert.match(send, /type: "authorized"/);
  assert.doesNotMatch(send, /userId|token|body|roomId|displayName/);
  assert.match(proto, /No room id, token, or message body/);
  const resume = index.slice(
    index.indexOf("private async handleParkedResume"),
    index.indexOf("private expireUnavailable")
  );
  assert.ok(resume.indexOf("expire(") < resume.indexOf("sendAuthorized"));
});

test("wrangler: new WS and resume send authorized then history; deny never does", async () => {
  const persistTo = mkdtempSync(join(tmpdir(), "authorized-frame-"));
  const uid = 400000 + (Date.now() % 100000);
  const { port, child, mock } = await startWrangler({ persistTo });
  const timing = {
    newWsAuthorizedToHistoryMs: null,
    resumeToAuthorizedMs: null,
    resumeAuthorizedToHistoryMs: null,
    wouldPaintSeparately: false,
  };
  try {
    const tok = signTestTokenV2({ userId: uid, displayName: "인가", role: "caddy", sv: 1 });
    mock.setEpoch(uid, 1);
    const { ws, frames } = await collectFromConnect(port, "all", tok.token);
    await waitMessage(ws, (d) => d.type === "history");
    const types = frames.map((f) => f.data.type);
    assert.equal(types[0], "authorized", "new WS first frame is authorized");
    assert.equal(types[1], "history", "new WS second frame is history");
    assert.equal(frames[0].data.userId, undefined);
    assert.equal(frames[0].data.token, undefined);
    assert.equal(frames[0].data.body, undefined);
    timing.newWsAuthorizedToHistoryMs = frames[1].t - frames[0].t;

    mock.setDelayMs(180);
    const resumeFrames = [];
    const onResume = (event) => {
      resumeFrames.push({ t: performance.now(), data: parseJson(event) });
    };
    ws.addEventListener("message", onResume);
    const tResume = performance.now();
    ws.send(JSON.stringify({ type: "resume" }));
    await waitMessage(ws, (d) => d.type === "history");
    ws.removeEventListener("message", onResume);
    mock.setDelayMs(0);
    const resumeTypes = resumeFrames.map((f) => f.data.type);
    assert.equal(resumeTypes[0], "authorized", "resume first frame is authorized");
    assert.equal(resumeTypes[1], "history", "resume second frame is history");
    timing.resumeToAuthorizedMs = resumeFrames[0].t - tResume;
    timing.resumeAuthorizedToHistoryMs = resumeFrames[1].t - resumeFrames[0].t;
    timing.wouldPaintSeparately = timing.resumeAuthorizedToHistoryMs >= 8;
    assert.ok(
      timing.resumeToAuthorizedMs >= 160,
      `authorized waits for session-check (${Math.round(timing.resumeToAuthorizedMs)}ms)`
    );

    ws.send(JSON.stringify({ type: "history", beforeSeq: 9007199254740991, limit: 30 }));
    const page = [];
    const onPage = (event) => page.push(parseJson(event).type);
    ws.addEventListener("message", onPage);
    await waitMessage(ws, (d) => d.type === "history");
    ws.removeEventListener("message", onPage);
    assert.equal(page.includes("authorized"), false, "pagination history does not re-send authorized");

    mock.setEpoch(uid, 2);
    const errWait = waitMessage(ws, (d) => d.type === "error");
    const closed = waitClose(ws, 12000);
    const denyFrames = [];
    const onDeny = (event) => denyFrames.push(parseJson(event).type);
    ws.addEventListener("message", onDeny);
    ws.send(JSON.stringify({ type: "resume" }));
    assert.equal((await errWait).code, "stale_session");
    await closed;
    ws.removeEventListener("message", onDeny);
    assert.equal(denyFrames.includes("authorized"), false, "stale resume sends no authorized");
  } finally {
    try {
      writeFileSync(
        ARTIFACT,
        JSON.stringify(
          {
            isolated: "local-wrangler",
            productionWorker: false,
            ...timing,
          },
          null,
          2
        )
      );
    } catch {
      // artifact dir may be missing in some sandboxes
    }
    await stopWrangler(child);
    try {
      rmSync(persistTo, { recursive: true, force: true });
    } catch {
      // temp
    }
  }
});
