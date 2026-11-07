/**
 * Parked resume verdict + protocol validator. No Worker/DB/network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parkedResumeVerdict } from "../src/parkedResume.ts";
import { validateIncomingResume } from "../src/protocol.ts";

test("validateIncomingResume accepts only type resume", () => {
  assert.equal(validateIncomingResume({ type: "resume" }).ok, true);
  assert.equal(validateIncomingResume({ type: "history", beforeSeq: 9 }).ok, false);
  assert.equal(validateIncomingResume(null).ok, false);
  assert.equal(validateIncomingResume("resume").ok, false);
  assert.equal(validateIncomingResume([]).ok, false);
});

test("parkedResumeVerdict is fail-closed", () => {
  const accessOk = { ok: true };
  const accessDeny = { ok: false, code: "room_forbidden" };
  assert.deepEqual(
    parkedResumeVerdict({ session: { ok: true }, access: accessOk }),
    { action: "allow" }
  );
  assert.deepEqual(
    parkedResumeVerdict({
      session: { ok: false, status: 401, error: "stale_session" },
      access: accessOk,
    }),
    { action: "deny", close: "stale_session" }
  );
  assert.deepEqual(
    parkedResumeVerdict({
      session: { ok: false, status: 401, error: "chat_blocked" },
      access: accessOk,
    }),
    { action: "deny", close: "stale_session" }
  );
  assert.deepEqual(
    parkedResumeVerdict({
      session: { ok: false, status: 503, error: "session_check_unavailable" },
      access: accessOk,
    }),
    { action: "deny", close: "unavailable" }
  );
  assert.deepEqual(
    parkedResumeVerdict({ session: { ok: true }, access: accessDeny }),
    { action: "deny", close: "room_forbidden" }
  );
  assert.deepEqual(
    parkedResumeVerdict({
      session: { ok: false, status: 401, error: "stale_session" },
      access: accessDeny,
    }),
    { action: "deny", close: "stale_session" },
    "session failure wins before membership"
  );
});
