/**
 * Kakao native-session contract + first-login User reuse (no network, no prod DB).
 *
 *   npm run test:kakao-native-session-unit
 */
import {
  EXPECTED_DEBUG_KAKAO_KEY_HASH,
  computeDebugKakaoKeyHash,
} from "./compute-android-kakao-debug-key-hash";
import {
  NATIVE_KAKAO_LOGIN_ENABLED,
  nativeKakaoSessionRequestInit,
  restKakaoStartUrl,
  runKakaoLogin,
  shouldUseNativeKakaoLogin,
} from "../src/lib/kakaoNativeBridge";
import {
  exchangeNativeKakaoSession,
  getKakaoAppIdConfig,
  kakaoAppIdMatches,
  kakaoBearerHeaders,
  nativeKakaoSessionHttpStatus,
  parseKakaoAccessTokenInfo,
  parseNativeKakaoSessionBody,
} from "../src/lib/kakaoNativeSession";
import { findOrCreateKakaoSessionUser } from "../src/lib/kakaoSessionUser";
import type { KakaoSessionUserRow } from "../src/lib/kakaoSessionUser";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

type StoreRow = KakaoSessionUserRow & { kakaoUserId: string; password: null };

function mockDb(seed: StoreRow[] = []) {
  const rows = [...seed];
  return {
    user: {
      async findUnique(args: { where: { kakaoUserId: string } }) {
        const found = rows.find((r) => r.kakaoUserId === args.where.kakaoUserId);
        if (!found) return null;
        return {
          id: found.id,
          username: found.username,
          role: found.role,
          sessionVersion: found.sessionVersion,
          caddyId: found.caddyId,
          caddy: found.employmentStatus
            ? { employmentStatus: found.employmentStatus }
            : null,
        };
      },
      async create(args: {
        data: {
          username: string;
          password: null;
          role: "caddy";
          caddyId: null;
          managedTeams: [];
          kakaoUserId: string;
        };
      }) {
        if (rows.some((r) => r.kakaoUserId === args.data.kakaoUserId)) {
          const err = new Error("unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row: StoreRow = {
          id: rows.length + 1,
          username: args.data.username,
          role: args.data.role,
          sessionVersion: 0,
          caddyId: args.data.caddyId,
          employmentStatus: null,
          kakaoUserId: args.data.kakaoUserId,
          password: null,
        };
        rows.push(row);
        return {
          id: row.id,
          username: row.username,
          role: row.role,
          sessionVersion: row.sessionVersion,
          caddyId: row.caddyId,
          caddy: null,
        };
      },
    },
    rows,
  };
}

async function main() {
section("debug key hash");
const hash = computeDebugKakaoKeyHash();
assert(hash === EXPECTED_DEBUG_KAKAO_KEY_HASH, `hash ${hash}`);
assert(
  EXPECTED_DEBUG_KAKAO_KEY_HASH === "M9h5pMYFj0yFLApYg+RqeR/8sdI=",
  "locked Kakao Developers debug key hash"
);

section("parseNativeKakaoSessionBody");
assert(
  parseNativeKakaoSessionBody({ accessToken: " tok " }).ok === true,
  "trims accessToken"
);
assert(
  parseNativeKakaoSessionBody({ accessToken: "tok", kakaoUserId: "1" }).ok ===
    false,
  "rejects client kakaoUserId"
);
assert(
  parseNativeKakaoSessionBody({ kakaoUserId: "1" }).error ===
    "client_kakao_id_not_trusted",
  "spoof id error code"
);
assert(
  parseNativeKakaoSessionBody({}).error === "missing_token",
  "missing token"
);
assert(
  parseNativeKakaoSessionBody(null).error === "invalid_json",
  "null body"
);
assert(
  parseNativeKakaoSessionBody({ accessToken: "a".repeat(5000) }).error ===
    "missing_token",
  "oversized token rejected"
);

section("token info + appId");
assert(
  parseKakaoAccessTokenInfo({ id: 99, appId: 123 }).kakaoUserId === "99",
  "token info id"
);
assert(
  parseKakaoAccessTokenInfo({ id: "99", app_id: "123" })?.appId === "123",
  "app_id alias"
);
assert(parseKakaoAccessTokenInfo({ id: 99 }) === null, "appId required");
assert(
  kakaoAppIdMatches("123", "123") === true,
  "appId match"
);
assert(
  kakaoAppIdMatches("123", "999") === false,
  "appId mismatch"
);
assert(
  kakaoAppIdMatches("123", null) === false,
  "missing configured appId fail-closed"
);
assert(getKakaoAppIdConfig({ KAKAO_APP_ID: "42" }) === "42", "env app id");
assert(getKakaoAppIdConfig({ KAKAO_APP_ID: "abc" }) === null, "reject non-numeric");
assert(
  kakaoBearerHeaders("abc").Authorization === "Bearer abc",
  "bearer header"
);

section("findOrCreateKakaoSessionUser first-login vs existing");
{
  const db = mockDb();
  const created = await findOrCreateKakaoSessionUser(db, "555");
  assert(created?.username === "kakao_555", "first-login username kakao_{id}");
  assert(created?.role === "caddy", "first-login role caddy");
  assert(db.rows[0]?.password === null, "created password null");
  const existing = await findOrCreateKakaoSessionUser(
    mockDb([
      {
        id: 9,
        username: "leader_kim",
        role: "leader",
        sessionVersion: 3,
        caddyId: 12,
        employmentStatus: "ACTIVE",
        kakaoUserId: "555",
        password: null,
      },
    ]),
    "555"
  );
  assert(existing?.username === "leader_kim", "existing username kept");
  assert(existing?.role === "leader", "existing role kept");
  assert(existing?.sessionVersion === 3, "sessionVersion reused");
}

section("exchangeNativeKakaoSession");
{
  const existing: StoreRow = {
    id: 4,
    username: "kakao_777",
    role: "admin",
    sessionVersion: 2,
    caddyId: null,
    employmentStatus: null,
    kakaoUserId: "777",
    password: null,
  };
  const db = mockDb([existing]);
  const ok = await exchangeNativeKakaoSession(
    { accessToken: "mem-only" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "777", appId: "1001" }),
      fetchUserId: async () => "777",
      findOrCreateUser: (id) => findOrCreateKakaoSessionUser(db, id),
    }
  );
  assert(ok.ok === true, "admin native exchange ok");
  if (ok.ok) {
    assert(ok.role === "admin", "admin role from User");
    assert(ok.href === "/manage" || ok.href.startsWith("/manage"), "admin → /manage");
    assert(ok.sessionVersion === 2, "sessionVersion from User");
    assert(
      !JSON.stringify(ok).includes("mem-only"),
      "result does not echo access token"
    );
  }

  const spoof = await exchangeNativeKakaoSession(
    { accessToken: "x", kakaoUserId: "777" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "777", appId: "1001" }),
      fetchUserId: async () => "777",
      findOrCreateUser: async () => existing,
    }
  );
  assert(spoof.ok === false && spoof.error === "client_kakao_id_not_trusted", "spoof rejected");

  const wrongApp = await exchangeNativeKakaoSession(
    { accessToken: "x" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "777", appId: "9999" }),
      fetchUserId: async () => "777",
      findOrCreateUser: async () => existing,
    }
  );
  assert(wrongApp.ok === false && wrongApp.error === "kakao_token", "foreign app token");

  const mismatch = await exchangeNativeKakaoSession(
    { accessToken: "x" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "777", appId: "1001" }),
      fetchUserId: async () => "888",
      findOrCreateUser: async () => existing,
    }
  );
  assert(mismatch.ok === false && mismatch.error === "kakao_token", "id mismatch");

  const retired = await exchangeNativeKakaoSession(
    { accessToken: "x" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "1", appId: "1001" }),
      fetchUserId: async () => "1",
      findOrCreateUser: async () => ({
        id: 8,
        username: "kakao_1",
        role: "caddy",
        sessionVersion: 0,
        caddyId: 44,
        employmentStatus: "RETIRED",
      }),
    }
  );
  assert(
    retired.ok === false && retired.error === "kakao_retired",
    "RETIRED caddy/leader not issued a session"
  );

  const unlinked = await exchangeNativeKakaoSession(
    { accessToken: "x" },
    {
      configuredAppId: "1001",
      fetchTokenInfo: async () => ({ kakaoUserId: "2", appId: "1001" }),
      fetchUserId: async () => "2",
      findOrCreateUser: async () => ({
        id: 10,
        username: "kakao_2",
        role: "caddy",
        sessionVersion: 0,
        caddyId: null,
        employmentStatus: null,
      }),
    }
  );
  assert(unlinked.ok === true, "unlinked caddy first-login /caddy/link still allowed");
  if (unlinked.ok) {
    assert(unlinked.href === "/caddy" || unlinked.href.startsWith("/caddy"), "caddy → /caddy");
  }
}

section("native bridge app-only");
assert(NATIVE_KAKAO_LOGIN_ENABLED === true, "native Kakao login flag on");
assert(
  shouldUseNativeKakaoLogin({ isNativePlatform: true }) === true,
  "Capacitor Android uses native Kakao"
);
assert(
  shouldUseNativeKakaoLogin({ isNativePlatform: false }) === false,
  "web/PWA never uses native Kakao"
);
assert(
  restKakaoStartUrl("/caddy") === "/api/auth/kakao/start?callbackUrl=%2Fcaddy",
  "REST start URL kept for web/PWA"
);
const reqInit = nativeKakaoSessionRequestInit("secret-token", "/caddy");
assert(reqInit.credentials === "include", "cookie credentials include");
assert(reqInit.method === "POST", "POST native-session");
assert(!reqInit.body.includes("kakaoUserId"), "body has no kakaoUserId");
assert(reqInit.body.includes("callbackUrl"), "optional callbackUrl allowed");
assert(
  nativeKakaoSessionHttpStatus("missing_token") === 400,
  "missing token 400"
);
assert(
  nativeKakaoSessionHttpStatus("client_kakao_id_not_trusted") === 400,
  "spoof id 400"
);
assert(nativeKakaoSessionHttpStatus("kakao_token") === 401, "bad token 401");
assert(
  nativeKakaoSessionHttpStatus("kakao_retired") === 403,
  "retired 403"
);
assert(nativeKakaoSessionHttpStatus("kakao_config") === 503, "config 503");

{
  const rest = await runKakaoLogin({
    isNativePlatform: false,
    callbackUrl: "/caddy",
    nativeLogin: async () => {
      throw new Error("native must not run on web");
    },
    exchangeSession: async () => {
      throw new Error("exchange must not run on web");
    },
  });
  assert(rest.mode === "rest", "web uses REST mode");
  assert(
    rest.mode === "rest" && rest.startUrl.includes("/api/auth/kakao/start"),
    "web start URL is REST"
  );

  const native = await runKakaoLogin({
    isNativePlatform: true,
    callbackUrl: "/caddy",
    nativeLogin: async () => ({ accessToken: "mem-only" }),
    exchangeSession: async (token, cb) => {
      assert(token === "mem-only", "exchange receives memory token");
      assert(cb === "/caddy", "callback forwarded");
      return { role: "caddy", href: "/caddy" };
    },
  });
  assert(native.mode === "native", "app uses native mode");
  assert(native.mode === "native" && native.href === "/caddy", "native href");
}

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
}

void main();
