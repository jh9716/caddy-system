import assert from "node:assert/strict";
import test from "node:test";
import { signTestToken } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

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

function connect(port, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    );
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

test("auth, A/B realtime, spoof, history, duplicate, isolation", async () => {
  const { port, child } = await startWrangler();
  const latencies = [];
  try {
    const health = await fetch(`http://${HOST}:${port}/health`);
    assert.equal(health.status, 200);

    const noTok = await fetch(`http://${HOST}:${port}/ws?room=team-1`);
    assert.equal(noTok.status, 401);

    const badTok = await fetch(`http://${HOST}:${port}/ws?room=team-1&token=nope`);
    assert.equal(badTok.status, 401);

    const expired = signTestToken({ exp: Math.floor(Date.now() / 1000) - 10 });
    const expRes = await fetch(
      `http://${HOST}:${port}/ws?room=team-1&token=${encodeURIComponent(expired.token)}`
    );
    assert.equal(expRes.status, 401);

    const aTok = signTestToken({ userId: 1, displayName: "A", room: "team-1", team: "1조" });
    const cross = await fetch(
      `http://${HOST}:${port}/ws?room=team-2&token=${encodeURIComponent(aTok.token)}`
    );
    assert.equal(cross.status, 403);

    const poc = await fetch(`http://${HOST}:${port}/ws?room=poc-room`);
    assert.equal(poc.status, 400);

    const a = await connect(port, "team-1", aTok.token);
    await waitMessage(a, (d) => d.type === "history");
    const bTok = signTestToken({ userId: 2, displayName: "B", room: "team-1", team: "1조" });
    const b = await connect(port, "team-1", bTok.token);
    await waitMessage(b, (d) => d.type === "history");

    const idAb = `ab-${Date.now()}`;
    const t0 = Date.now();
    const bGot = waitMessage(b, (d) => d.type === "message" && d.clientMessageId === idAb);
    a.send(
      JSON.stringify({
        type: "message",
        clientMessageId: idAb,
        sender: "SPOOF",
        body: "hello-from-a",
      })
    );
    const fromA = await bGot;
    latencies.push({ path: "A->B", ms: Date.now() - t0 });
    assert.equal(fromA.sender, "A");
    assert.equal(fromA.senderUserId, 1);
    assert.equal(fromA.body, "hello-from-a");

    const idBa = `ba-${Date.now()}`;
    const t1 = Date.now();
    const aGot = waitMessage(a, (d) => d.type === "message" && d.clientMessageId === idBa);
    b.send(JSON.stringify({ type: "message", clientMessageId: idBa, body: "hello-from-b" }));
    const fromB = await aGot;
    latencies.push({ path: "B->A", ms: Date.now() - t1 });
    assert.equal(fromB.sender, "B");
    assert.equal(fromB.senderUserId, 2);

    const otherTok = signTestToken({
      userId: 3,
      displayName: "C",
      room: "team-2",
      team: "2조",
    });
    const other = await connect(port, "team-2", otherTok.token);
    const otherHistory = await waitMessage(other, (d) => d.type === "history");
    assert.equal(otherHistory.messages.length, 0);
    let leaked = false;
    other.addEventListener("message", (event) => {
      const data = parseJson(event);
      if (data.type === "message" && data.body === "hello-from-a") leaked = true;
    });
    a.send(
      JSON.stringify({
        type: "message",
        clientMessageId: `iso-${Date.now()}`,
        body: "room-a-only",
      })
    );
    await waitMessage(b, (d) => d.type === "message" && d.body === "room-a-only");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(leaked, false);
    other.close();

    const bad = waitMessage(a, (d) => d.type === "error");
    a.send("not-json");
    const malformed = await bad;
    assert.equal(malformed.code, "invalid_payload");

    const long = waitMessage(a, (d) => d.type === "error" && d.code === "body_too_long");
    a.send(
      JSON.stringify({
        type: "message",
        clientMessageId: `long-${Date.now()}`,
        body: "x".repeat(2001),
      })
    );
    await long;

    const huge = waitMessage(a, (d) => d.type === "error" && d.code === "payload_too_large");
    a.send(`{"type":"message","clientMessageId":"big","body":"${"x".repeat(5000)}"}`);
    await huge;

    let extra = 0;
    const extraListener = (event) => {
      const data = parseJson(event);
      if (data.type === "message" && data.clientMessageId === idAb) extra += 1;
    };
    b.addEventListener("message", extraListener);
    const dup = waitMessage(a, (d) => d.type === "duplicate" && d.clientMessageId === idAb);
    a.send(JSON.stringify({ type: "message", clientMessageId: idAb, body: "again" }));
    await dup;
    await new Promise((r) => setTimeout(r, 200));
    b.removeEventListener("message", extraListener);
    assert.equal(extra, 0);

    a.close();
    const c = await connect(port, "team-1", aTok.token);
    const cHistory = await waitMessage(c, (d) => d.type === "history");
    const ids = cHistory.messages.map((m) => m.clientMessageId);
    assert.ok(ids.includes(idAb));
    assert.ok(ids.includes(idBa));
    const seqs = cHistory.messages.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    assert.ok(cHistory.messages.length <= 30);
    assert.equal(cHistory.hasMore, false);

    b.close();
    c.close();
    console.log("LOCAL_LATENCY", JSON.stringify(latencies));
  } finally {
    await stopWrangler(child);
  }
});
