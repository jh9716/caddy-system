import { createHmac } from "node:crypto";

export const TEST_SECRET = "phase1-local-test-only";

export function signTestToken(partial, secret = TEST_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    userId: 11,
    displayName: "Tester",
    role: "caddy",
    team: "1조",
    room: "team-1",
    iat: now,
    exp: now + 600,
    ...partial,
  };
  const canonical = [
    String(claims.v),
    String(claims.userId),
    String(claims.displayName).replace(/\|/g, "").trim(),
    claims.role,
    claims.team,
    claims.room,
    String(claims.iat),
    String(claims.exp),
  ].join("|");
  const body = Buffer.from(canonical, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(canonical).digest("base64url");
  return { token: `${body}.${sig}`, claims };
}

export function signTestTokenV2(partial, secret = TEST_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 2,
    userId: 11,
    displayName: "Tester",
    role: "caddy",
    team: "1조",
    iat: now,
    exp: now + 600,
    ...partial,
  };
  const canonical = [
    String(claims.v),
    String(claims.userId),
    String(claims.displayName).replace(/\|/g, "").trim(),
    claims.role,
    claims.team || "-",
    String(claims.iat),
    String(claims.exp),
  ].join("|");
  const body = Buffer.from(canonical, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(canonical).digest("base64url");
  return { token: `${body}.${sig}`, claims };
}

export function signCreateGrant(grant, secret = TEST_SECRET) {
  const members = grant.members
    .map((m) => `${m.userId}:${m.displayName}:${m.role}:${m.team}`)
    .sort()
    .join(",");
  const canonical = [
    String(grant.v),
    grant.op,
    grant.roomId,
    grant.name,
    String(grant.ownerUserId),
    members,
    String(grant.iat),
    String(grant.exp),
  ].join("|");
  const body = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(canonical).digest("base64url");
  return `${body}.${sig}`;
}
