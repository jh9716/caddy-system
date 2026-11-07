/**
 * Preview 전용 WS 구간 계측: perf 프레임(ms·colo·doFirst) + vh-perf-ping/pong.
 * 운영 Worker 는 프레임/퐁을 보내지 않는다. 인증·멤버십·세션폐기는 그대로.
 * Local wrangler only. No deploy, no DB, no secrets printed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_SECRET = "preview-local-perf-only";

function waitRaw(ws, pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const onMsg = (ev) => {
      const raw = String(ev.data);
      if (pred(raw)) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        resolve(raw);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}

function connectPreviewRoom(port, token) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=all&token=${encodeURIComponent(token)}`
    );
    let openMs = null;
    const timer = setTimeout(() => reject(new Error("room timeout")), 10000);
    ws.addEventListener("open", () => {
      openMs = performance.now() - t0;
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("room ws error"));
    });
    const pending = { history: null, perf: null };
    const maybeDone = () => {
      if (pending.history && pending.perf) {
        clearTimeout(timer);
        resolve({ ws, openMs, historyMs: pending.history, perf: pending.perf });
      }
    };
    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data);
      let d;
      try {
        d = JSON.parse(raw);
      } catch {
        return;
      }
      if (d.type === "history") pending.history = performance.now() - t0;
      if (d.type === "perf") pending.perf = d;
      maybeDone();
    });
  });
}

test("source: Preview perf is gated; ChatRoom still full authorizeSocket", () => {
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const dir = readFileSync(join(root, "src/directory.ts"), "utf8");
  const perf = readFileSync(join(root, "src/chatPerf.ts"), "utf8");
  assert.match(index, /isPreviewChatPerf/);
  assert.match(index, /isPreviewPerfPing/);
  assert.match(index, /const authorized = await authorizeSocket\(\s*request,\s*this\.env/);
  assert.doesNotMatch(
    index,
    /authorizeSocket\(\s*request,\s*this\.env,\s*\{[^}]*sessionCheck:\s*"skip"/
  );
  assert.match(dir, /isPreviewChatPerf/);
  assert.doesNotMatch(perf, /CHAT_AUTH_SECRET|PREVIEW_APP_BYPASS|userId|token=/);
});

test("Preview WS: perf frame + ping pong; production has neither", async () => {
  const prod = await startWrangler();
  const prev = await startWrangler({
    secret: PREVIEW_SECRET,
    extraArgs: ["--env", "preview"],
  });
  try {
    prev.mock.setDelayMs(80);
    const prevTok = signTestTokenV2(
      { userId: 61, displayName: "계측", role: "caddy", sv: 3, aud: "preview" },
      PREVIEW_SECRET
    ).token;
    prev.mock.setEpoch(61, 3);

    const room = await connectPreviewRoom(prev.port, prevTok);
    assert.equal(room.perf.type, "perf");
    const t = room.perf.t;
    assert.equal(typeof t.sc, "number");
    assert.ok(t.sc >= 70, `session-check RTT should include mock 80ms, got ${t.sc}`);
    assert.equal(t.scApp, 80);
    assert.equal(t.scDb, 1);
    assert.ok(t.scCold === 0 || t.scCold === 1);
    assert.equal(t.doFirst, 1);
    assert.ok(t.doAssert >= t.sc, "DO assert includes session-check");
    assert.ok(typeof t.edge === "number", "Worker edge time forwarded");
    assert.ok(typeof t.tok === "number");
    assert.ok(typeof t.doAccept === "number");
    assert.ok(typeof t.doHist === "number");
    assert.equal(t.userId, undefined);
    assert.equal(t.token, undefined);
    assert.doesNotMatch(JSON.stringify(room.perf), /http|token=|userId|bypass/i);

    const pong = waitRaw(room.ws, (raw) => raw === "vh-perf-pong");
    room.ws.send("vh-perf-ping");
    assert.equal(await pong, "vh-perf-pong");
    room.ws.close();

    const again = await connectPreviewRoom(prev.port, prevTok);
    assert.equal(again.perf.t.doFirst, 0, "second handshake on same DO is not first fetch");
    again.ws.close();

    const prodTok = signTestTokenV2({ userId: 61, displayName: "운영", role: "caddy", sv: 3 }).token;
    prod.mock.setEpoch(61, 3);
    const prodWs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://${HOST}:${prod.port}/ws?room=all&token=${encodeURIComponent(prodTok)}`
      );
      const timer = setTimeout(() => reject(new Error("prod timeout")), 8000);
      const types = [];
      ws.addEventListener("message", (ev) => {
        const d = JSON.parse(String(ev.data));
        types.push(d.type);
        if (d.type === "history") {
          clearTimeout(timer);
          resolve({ ws, types });
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("prod ws error"));
      });
    });
    assert.ok(!prodWs.types.includes("perf"), "production must not emit perf frames");
    const errP = waitRaw(prodWs.ws, (raw) => {
      try {
        return JSON.parse(raw).type === "error";
      } catch {
        return raw === "vh-perf-pong";
      }
    });
    prodWs.ws.send("vh-perf-ping");
    const errRaw = await errP;
    assert.notEqual(errRaw, "vh-perf-pong", "production must not pong perf ping");
    prodWs.ws.close();
  } finally {
    await stopWrangler(prod.child);
    await stopWrangler(prev.child);
  }
});
