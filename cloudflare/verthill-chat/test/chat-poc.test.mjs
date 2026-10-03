import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";

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

function connect(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=${room}`);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
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
        output.includes("Ready on") ||
        output.includes(`http://${HOST}:${port}`) ||
        output.includes("Starting local server")
      ) {
        if (
          output.includes("Ready") ||
          output.includes("ready") ||
          /http:\/\/127\.0\.0\.1:\d+/.test(output)
        ) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          resolve();
        }
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
  child.kill("SIGTERM");
  const done = once(child, "exit");
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 1000))]);
  }
}

test("local wrangler A/B realtime, history, reconnect, duplicate, isolation", async (t) => {
  const { port, child } = await startWrangler();
  const latencies = [];
  try {
    const health = await fetch(`http://${HOST}:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "verthill-chat" });

    const a = await connect(port, "poc-room");
    const aHistory = await waitMessage(a, (d) => d.type === "history");
    assert.equal(Array.isArray(aHistory.messages), true);

    const b = await connect(port, "poc-room");
    const bHistory = await waitMessage(b, (d) => d.type === "history");
    assert.equal(bHistory.messages.length, aHistory.messages.length);

    const idAb = `ab-${Date.now()}`;
    const t0 = Date.now();
    const bGot = waitMessage(
      b,
      (d) => d.type === "message" && d.clientMessageId === idAb
    );
    sendMessage(a, {
      clientMessageId: idAb,
      sender: "A",
      body: "hello-from-a",
      sentAt: new Date().toISOString(),
    });
    const fromA = await bGot;
    latencies.push({ path: "A->B", ms: Date.now() - t0 });
    assert.equal(fromA.sender, "A");
    assert.equal(fromA.body, "hello-from-a");
    assert.equal(typeof fromA.seq, "number");

    const idBa = `ba-${Date.now()}`;
    const t1 = Date.now();
    const aGot = waitMessage(
      a,
      (d) => d.type === "message" && d.clientMessageId === idBa
    );
    sendMessage(b, {
      clientMessageId: idBa,
      sender: "B",
      body: "hello-from-b",
    });
    const fromB = await aGot;
    latencies.push({ path: "B->A", ms: Date.now() - t1 });
    assert.equal(fromB.sender, "B");
    assert.equal(fromB.body, "hello-from-b");

    const other = await connect(port, "other-room");
    const otherHistory = await waitMessage(other, (d) => d.type === "history");
    assert.equal(otherHistory.messages.length, 0);
    let leaked = false;
    other.addEventListener("message", (event) => {
      const data = parseJson(event);
      if (data.type === "message" && data.body === "hello-from-a") leaked = true;
    });
    sendMessage(a, {
      clientMessageId: `iso-${Date.now()}`,
      sender: "A",
      body: "room-a-only",
    });
    await waitMessage(b, (d) => d.type === "message" && d.body === "room-a-only");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(leaked, false);
    other.close();

    const bad = waitMessage(a, (d) => d.type === "error");
    a.send("not-json");
    const malformed = await bad;
    assert.equal(malformed.code, "invalid_payload");

    const long = waitMessage(a, (d) => d.type === "error" && d.code === "body_too_long");
    sendMessage(a, {
      clientMessageId: `long-${Date.now()}`,
      sender: "A",
      body: "x".repeat(2001),
    });
    await long;

    let extra = 0;
    const extraListener = (event) => {
      const data = parseJson(event);
      if (data.type === "message" && data.clientMessageId === idAb) extra += 1;
    };
    b.addEventListener("message", extraListener);
    const dup = waitMessage(a, (d) => d.type === "duplicate" && d.clientMessageId === idAb);
    sendMessage(a, {
      clientMessageId: idAb,
      sender: "A",
      body: "hello-from-a-again",
    });
    await dup;
    await new Promise((r) => setTimeout(r, 200));
    b.removeEventListener("message", extraListener);
    assert.equal(extra, 0);

    a.close();
    const c = await connect(port, "poc-room");
    const cHistory = await waitMessage(c, (d) => d.type === "history");
    const ids = cHistory.messages.map((m) => m.clientMessageId);
    assert.ok(ids.includes(idAb));
    assert.ok(ids.includes(idBa));
    const seqs = cHistory.messages.map((m) => m.seq);
    const sorted = [...seqs].sort((x, y) => x - y);
    assert.deepEqual(seqs, sorted);
    assert.ok(cHistory.messages.length <= 30);

    const reconnectId = `rc-${Date.now()}`;
    const cGot = waitMessage(
      c,
      (d) => d.type === "message" && d.clientMessageId === reconnectId
    );
    sendMessage(b, {
      clientMessageId: reconnectId,
      sender: "B",
      body: "after-reconnect",
    });
    const after = await cGot;
    assert.equal(after.body, "after-reconnect");

    const d = await connect(port, "poc-room");
    const dHistory = await waitMessage(d, (dmsg) => dmsg.type === "history");
    assert.ok(dHistory.messages.some((m) => m.clientMessageId === reconnectId));
    assert.ok(dHistory.messages.length <= 30);

    b.close();
    c.close();
    d.close();

    console.log("LOCAL_LATENCY", JSON.stringify(latencies));
  } finally {
    await stopWrangler(child);
  }
});
