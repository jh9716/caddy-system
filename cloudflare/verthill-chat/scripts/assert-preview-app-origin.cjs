// Preview Worker 가 호출할 Next 앱 origin 검증 (워크플로 입력용). src/nextApp.ts 의 PREVIEW_APP_HOST 와 같은 값만 허용 (테스트가 동일성 검사).
// 허용: 정확히 https://caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app (끝 "/" 하나는 허용)
"use strict";
const PREVIEW_APP_HOST = "caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app";
const ORIGIN = `https://${PREVIEW_APP_HOST}`;
function isAllowedPreviewOrigin(s) {
  s = String(s ?? "");
  return s === ORIGIN || s === ORIGIN + "/";
}
module.exports = { isAllowedPreviewOrigin, PREVIEW_APP_HOST, ORIGIN };
if (require.main === module) {
  const ok = isAllowedPreviewOrigin(process.argv[2]);
  console.log(ok ? "preview app origin: OK" : `preview app origin: REJECTED (must be exactly ${ORIGIN})`);
  process.exit(ok ? 0 : 1);
}
