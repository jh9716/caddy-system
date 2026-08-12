/**
 * Kakao OAuth 헬퍼 단위 테스트 (네트워크/DB 없음)
 * npx tsx scripts/test-kakao-oauth-unit.ts
 */
import {
  kakaoUsernameFromId,
  normalizeKakaoUserId,
  safeReturnPath,
  statesMatch,
} from "../src/lib/kakaoOAuth";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

console.log("== normalizeKakaoUserId ==");
assert(normalizeKakaoUserId(1234567890) === "1234567890", "number id");
assert(normalizeKakaoUserId("9876543210") === "9876543210", "string id");
assert(normalizeKakaoUserId("nick") === null, "reject nickname");
assert(normalizeKakaoUserId("") === null, "reject empty");
assert(normalizeKakaoUserId(null) === null, "reject null");

console.log("== kakaoUsernameFromId ==");
assert(kakaoUsernameFromId("42") === "kakao_42", "username prefix");
let threw = false;
try {
  kakaoUsernameFromId("abc");
} catch {
  threw = true;
}
assert(threw, "non-numeric id throws");

console.log("== safeReturnPath ==");
assert(safeReturnPath("/caddy") === "/caddy", "relative ok");
assert(safeReturnPath("/manage/users") === "/manage/users", "nested ok");
assert(safeReturnPath("https://evil.com") === null, "absolute rejected");
assert(safeReturnPath("//evil.com") === null, "protocol-relative rejected");
assert(safeReturnPath("") === null, "empty null");

console.log("== statesMatch ==");
assert(statesMatch("abc123", "abc123") === true, "match");
assert(statesMatch("abc123", "abc124") === false, "mismatch");
assert(statesMatch(null, "x") === false, "null cookie");
assert(statesMatch("x", null) === false, "null query");

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
