import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const ARTIFACT = "/opt/cursor/artifacts/cf-chat-poc-audit.json";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function parseJson(event) {
  return JSON.parse(String(event.data));
}

function waitMessage(ws, predicate, timeoutMs = 12000) {
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

function connect(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}`);
    const timer = setTimeout(() => reject(new Error(`ws open timeout room=${room}`)), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`ws error room=${room}`));
    });
  });
}

function sendMessage(ws, payload) {
  ws.send(JSON.stringify({ type: "message", ...payload }));
}

async function startWrangler() {
  const port = await freePort();
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(port), "--ip", HOST],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`wrangler ready timeout\n${output}`));
    }, 45000);
    const onData = (buf) => {
      output += buf.toString();
      if (
        (output.includes("Ready") || output.includes("ready") || /http:\/\/127\.0\.0\.1:\d+/.test(output)) &&
        (output.includes("Ready on") || output.includes(`http://${HOST}:${port}`) || output.includes("Starting local server"))
      ) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrangler exited ${code}\n${output}`));
    });
  });
  await ready;
  await new Promise((r) => setTimeout(r, 300));
  return { port, child, output };
}

async function stopWrangler(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 2000))]);
  if (child.exitCode == null && child.signalCode == null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 1000))]);
  }
}

async function drainHistory(ws) {
  return waitMessage(ws, (d) => d.type === "history");
}

test("room allowlist, validation, prune, 200-cap, DO restart", async () => {
  const report = { startedAt: new Date().toISOString(), cases: {} };
  const { port, child } = await startWrangler();
  let restartId = "";
  try {
    const health = await fetch(`http://${HOST}:${port}/health`);
    assert.equal(health.status, 200);
    report.cases.health = await health.json();

    const roomCases = [
      ["", 400],
      ["poc room", 400],
      ["poc/room", 400],
      ["poc.room", 400],
      ["x".repeat(65), 400],
      ["poc-room!", 400],
      ["brute-room-1", 400],
      ["audit-room", 400],
      ["poc-room", 426],
      ["other-room", 426],
    ];
    const roomResults = [];
    for (const [room, expected] of roomCases) {
      const res = await fetch(`http://${HOST}:${port}/ws?room=${encodeURIComponent(room)}`);
      const body = await res.json();
      roomResults.push({ room: room || "(empty)", status: res.status, expected, body });
      assert.equal(res.status, expected, `room=${room || "(empty)"}`);
    }
    report.cases.rooms = roomResults;

    const a = await connect(port, "poc-room");
    await drainHistory(a);
    const validation = [];
    const expectError = async (label, raw, code) => {
      const got = waitMessage(a, (d) => d.type === "error");
      if (typeof raw === "string") a.send(raw);
      else if (raw instanceof Uint8Array) a.send(raw);
      else a.send(JSON.stringify(raw));
      const err = await got;
      assert.equal(err.code, code, label);
      validation.push({ label, code: err.code, pass: true });
    };
    await expectError("malformed", "not-json", "invalid_payload");
    await expectError("array", [], "invalid_payload");
    await expectError("type mismatch", { type: "ping", clientMessageId: "x", sender: "A", body: "b" }, "invalid_type");
    await expectError("empty sender", { type: "message", clientMessageId: "s1", sender: "  ", body: "b" }, "invalid_sender");
    await expectError("empty body", { type: "message", clientMessageId: "s2", sender: "A", body: "" }, "invalid_body");
    await expectError("body 2001", { type: "message", clientMessageId: "s3", sender: "A", body: "x".repeat(2001) }, "body_too_long");
    await expectError("huge clientMessageId", { type: "message", clientMessageId: "i".repeat(129), sender: "A", body: "b" }, "invalid_client_message_id");
    await expectError("huge sender", { type: "message", clientMessageId: "s4", sender: "S".repeat(65), body: "b" }, "invalid_sender");
    await expectError("binary", new Uint8Array([1, 2, 3, 4]), "invalid_payload");
    await expectError("huge frame", `{"type":"message","clientMessageId":"big","sender":"A","body":"${"x".repeat(5000)}"}`, "payload_too_large");

    const spoofAt = "1999-01-01T00:00:00.000Z";
    const spoofId = `spoof-${Date.now()}`;
    const spoofWait = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === spoofId);
    sendMessage(a, {
      clientMessageId: spoofId,
      sender: "A",
      body: "spoof",
      sentAt: spoofAt,
      extra: "ignored",
    });
    const spoofed = await spoofWait;
    assert.notEqual(spoofed.sentAt, spoofAt);
    validation.push({ label: "sentAt spoof ignored", pass: true, sentAt: spoofed.sentAt });
    report.cases.validation = validation;

    const b = await connect(port, "poc-room");
    await drainHistory(b);
    const n = 10;
    const waiters = [];
    for (let i = 0; i < n; i += 1) {
      const idA = `ca-${Date.now()}-${i}`;
      const idB = `cb-${Date.now()}-${i}`;
      waiters.push(waitMessage(b, (d) => d.type === "message" && d.clientMessageId === idA));
      waiters.push(waitMessage(a, (d) => d.type === "message" && d.clientMessageId === idB));
      sendMessage(a, { clientMessageId: idA, sender: "A", body: `ca-${i}` });
      sendMessage(b, { clientMessageId: idB, sender: "B", body: `cb-${i}` });
    }
    const got = await Promise.all(waiters);
    const seqs = got.map((m) => m.seq).sort((x, y) => x - y);
    assert.equal(new Set(seqs).size, seqs.length);
    const sameId = `dup-race-${Date.now()}`;
    const dupWait = waitMessage(a, (d) => d.type === "duplicate" && d.clientMessageId === sameId);
    const firstWait = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === sameId);
    sendMessage(a, { clientMessageId: sameId, sender: "A", body: "one" });
    sendMessage(a, { clientMessageId: sameId, sender: "A", body: "two" });
    await firstWait;
    await dupWait;
    report.cases.concurrency = { dualSends: n * 2, uniqueSeq: new Set(seqs).size };

    const prefix = `hist-${Date.now()}`;
    for (let i = 0; i < 35; i += 1) {
      const id = `${prefix}-${i}`;
      const waiter = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === id);
      sendMessage(a, { clientMessageId: id, sender: "A", body: `h-${i}` });
      await waiter;
    }
    a.close();
    b.close();
    const histClient = await connect(port, "poc-room");
    const history = await drainHistory(histClient);
    const histIds = history.messages.map((m) => m.clientMessageId);
    const histSeqs = history.messages.map((m) => m.seq);
    assert.ok(history.messages.length <= 30);
    assert.deepEqual(histSeqs, [...histSeqs].sort((x, y) => x - y));
    assert.equal(histIds.includes(`${prefix}-0`), false);
    assert.equal(histIds.includes(`${prefix}-34`), true);
    report.cases.history = {
      count: history.messages.length,
      oldestOf35Dropped: true,
      seqOrdered: true,
    };
    histClient.close();

    const other = await connect(port, "other-room");
    const otherHistory = await drainHistory(other);
    assert.equal(
      otherHistory.messages.some((m) => String(m.clientMessageId).startsWith(prefix)),
      false
    );
    other.close();

    const smokeN = 200;
    const sockets = [];
    for (let i = 0; i < smokeN; i += 1) {
      const ws = await connect(port, "poc-room");
      await drainHistory(ws);
      sockets.push(ws);
    }
    let fullRejected = false;
    try {
      await connect(port, "poc-room");
    } catch {
      fullRejected = true;
    }
    assert.equal(fullRejected, true);
    const smokeId = `smoke-${Date.now()}`;
    const waits = sockets.map((ws) =>
      waitMessage(ws, (d) => d.type === "message" && d.clientMessageId === smokeId, 20000)
    );
    const t0 = Date.now();
    sendMessage(sockets[0], { clientMessageId: smokeId, sender: "S", body: "broadcast-smoke" });
    await Promise.all(waits);
    report.cases.smoke = { clients: smokeN, received: smokeN, ms: Date.now() - t0, cap201: "rejected" };
    sockets[0].close();
    await new Promise((r) => setTimeout(r, 150));
    const afterClose = await connect(port, "poc-room");
    await drainHistory(afterClose);
    afterClose.close();
    for (const ws of sockets.slice(1)) ws.close();

    restartId = `restart-${Date.now()}`;
    const persistWs = await connect(port, "poc-room");
    await drainHistory(persistWs);
    const persistWait = waitMessage(persistWs, (d) => d.clientMessageId === restartId);
    sendMessage(persistWs, { clientMessageId: restartId, sender: "P", body: "keep-me" });
    await persistWait;
    persistWs.close();
    report.cases.preRestartId = restartId;
  } finally {
    await stopWrangler(child);
  }

  const restarted = await startWrangler();
  try {
    const ws = await connect(restarted.port, "poc-room");
    const history = await drainHistory(ws);
    const found = history.messages.some((m) => m.clientMessageId === restartId);
    report.cases.doRestart = {
      recovered: found,
      historyCount: history.messages.length,
      id: restartId,
    };
    assert.equal(found, true, "SQLite history must survive wrangler restart");
    ws.close();
  } finally {
    await stopWrangler(restarted.child);
  }

  report.finishedAt = new Date().toISOString();
  try {
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    writeFileSync(ARTIFACT, JSON.stringify(report, null, 2));
  } catch {
    // artifacts dir may be unavailable in CI
  }
  console.log("AUDIT_EXTRA", JSON.stringify(report));
});
