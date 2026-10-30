// Preview DB 연결 주소 검증 (값은 절대 출력하지 않는다).
// 허용: postgresql://<user>:<pw>@ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require[&channel_binding=require]
"use strict";

const PREVIEW_HOST = "ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech";
const PREVIEW_DB = "neondb";
const PREVIEW_PROJECT_ID = "lucky-mode-29989630";
// 운영 프로젝트(morning-tooth-60659454)의 endpoint id (저장소 밖 문서에서 확인한 공개 식별자, 비밀값 아님)
const PRODUCTION_MARKERS = ["ep-crimson-cell-a1i1tpce", "morning-tooth-60659454"];
const ALLOWED_PARAMS = new Set(["sslmode", "channel_binding"]);

function fail(reason) {
  return { ok: false, reason };
}

/** @returns {{ok:true, user:string, password:string, host:string, database:string} | {ok:false, reason:string}} */
function validatePreviewDbUrl(raw, opts = {}) {
  const s = String(raw ?? "");
  if (!s) return fail("empty");
  if (s !== s.trim() || /[\s\u0000-\u001f\u007f]/.test(s)) return fail("whitespace_or_control");
  const lower = s.toLowerCase();
  for (const m of PRODUCTION_MARKERS) if (lower.includes(m)) return fail("production_marker");
  if (lower.includes("pooler") || lower.includes("pgbouncer")) return fail("pooler");
  let u;
  try {
    u = new URL(s);
  } catch {
    return fail("unparseable");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return fail("scheme");
  // authority 원문과 파싱 결과 비교 (@ 다중·인코딩 트릭 차단)
  const m = /^[a-z]+:\/\/([^/?#]*)/i.exec(s);
  const authority = m ? m[1] : "";
  if ((authority.match(/@/g) || []).length !== 1) return fail("userinfo_shape");
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPart !== u.host) return fail("host_normalization");
  const local = opts.localHarness === true;
  if (!local && u.port !== "" && u.port !== "5432") return fail("port");
  if (!u.username || !u.password) return fail("credentials_missing");
  if (local) {
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return fail("host");
  } else if (u.hostname !== PREVIEW_HOST) {
    return fail("host");
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (db !== PREVIEW_DB) return fail("database");
  if (u.hash) return fail("fragment");
  const keys = [...u.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return fail("duplicate_param");
  for (const k of keys) if (!ALLOWED_PARAMS.has(k)) return fail("unexpected_param");
  if (!local && u.searchParams.get("sslmode") !== "require") return fail("sslmode");
  const cb = u.searchParams.get("channel_binding");
  if (cb !== null && cb !== "require") return fail("channel_binding");
  return {
    ok: true,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    database: db,
  };
}

module.exports = { validatePreviewDbUrl, PREVIEW_HOST, PREVIEW_DB, PREVIEW_PROJECT_ID, PRODUCTION_MARKERS };

// CLI: DATABASE_URL 검증. GitHub Actions 에서는 URL/user/password 를 마스킹하고, 이유 코드만 출력.
if (require.main === module) {
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const localHarness = process.argv.includes("--local-harness");
  if (localHarness && inActions) {
    console.error("preview-db guard: --local-harness is not allowed in GitHub Actions");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL || "";
  if (inActions && url) {
    const lines = [url];
    try {
      const u = new URL(url);
      if (u.username) lines.push(u.username, decodeURIComponent(u.username));
      if (u.password) lines.push(u.password, decodeURIComponent(u.password));
    } catch {}
    for (const l of lines) if (l) process.stdout.write(`::add-mask::${l}\n`);
  }
  const r = validatePreviewDbUrl(url, { localHarness });
  if (!r.ok) {
    console.error(`preview-db guard: REJECTED (${r.reason}). Stopping before any DB access.`);
    process.exit(2);
  }
  console.log(`preview-db guard: OK host=${r.host} database=${r.database} direct=true sslmode=${localHarness ? "local-harness" : "require"}`);
}
