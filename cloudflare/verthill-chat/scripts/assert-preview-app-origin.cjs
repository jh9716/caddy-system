// Preview Worker 가 호출할 Next 앱 origin 검증 (워크플로 입력용). src/nextApp.ts 와 같은 규칙 (테스트가 동일성 검사).
// 사용: node scripts/assert-preview-app-origin.cjs "<https://caddy-system-gt8t-...-jh9716s-projects.vercel.app>"
"use strict";
const PREVIEW_VERCEL_HOST = /^caddy-system-gt8t-[a-z0-9](?:[a-z0-9-]{0,80}[a-z0-9])?-jh9716s-projects\.vercel\.app$/;
function isAllowedPreviewOrigin(s) {
  s = String(s || "");
  if (!s || s !== s.trim() || s.length > 2048) return false;
  if (/[\s\\%\u0000-\u001f\u007f-\uffff]/.test(s)) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port !== "" || u.search || u.hash) return false;
  const m = /^https:\/\/([^/?#]*)/.exec(s);
  if (!m || m[1] !== u.hostname) return false;
  if (u.pathname !== "/") return false;
  if (u.hostname === "www.verthill.kr" || u.hostname === "verthill.kr" || u.hostname.endsWith(".verthill.kr")) return false;
  return PREVIEW_VERCEL_HOST.test(u.hostname);
}
module.exports = { isAllowedPreviewOrigin, PREVIEW_VERCEL_HOST };
if (require.main === module) {
  const ok = isAllowedPreviewOrigin(process.argv[2]);
  console.log(ok ? "preview app origin: OK" : "preview app origin: REJECTED (must be https://caddy-system-gt8t-*-jh9716s-projects.vercel.app with no path/port/query)");
  process.exit(ok ? 0 : 1);
}
