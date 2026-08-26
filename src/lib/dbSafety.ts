/**
 * Database URL safety for tests, fixtures, and the Next.js app.
 * Production Neon writes require an explicit maintenance confirm token.
 * Do not use a generic ALLOW_PROD_DB=1 switch.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const PRODUCTION_HOST_MARKERS = [
  "neon.tech",
  "vercel-storage",
  "amazonaws.com",
  "verthill",
];

export function parseDatabaseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error("DATABASE_URL parse 실패");
  }
}

export function isLocalDatabaseUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = parseDatabaseUrl(url).hostname;
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function isProductionDatabaseUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = parseDatabaseUrl(url);
  } catch {
    return false;
  }
  const host = parsed.hostname || "";
  if (PRODUCTION_HOST_MARKERS.some((m) => host.includes(m))) return true;
  const prod = process.env.PRODUCTION_DATABASE_URL;
  return Boolean(prod && prod === url);
}

export function assertLocalDatabaseUrl(
  url: string | undefined | null,
  message = "localhost 테스트 DB만 허용"
): string {
  if (!url) {
    throw new Error(`DATABASE_URL 이 없습니다. ${message}`);
  }
  const parsed = parseDatabaseUrl(url);
  const host = parsed.hostname;
  if (isProductionDatabaseUrl(url) || !LOCAL_HOSTS.has(host)) {
    throw new Error(
      `⛔ Production/원격 DB write 차단: host=${host}. ${message}.`
    );
  }
  return url;
}

export function assertNotProductionDatabaseUrl(
  url: string | undefined | null,
  context: string
): void {
  if (!url) return;
  if (isProductionDatabaseUrl(url)) {
    throw new Error(
      `⛔ ${context}: production/Neon DATABASE_URL 감지. 테스트·fixture·seed write 중단.`
    );
  }
}

/** Next.js / Vercel app runtime — production URL is expected here. */
export function isDeployedAppRuntime(): boolean {
  if (process.env.VERCEL === "1") return true;
  const args = process.argv.join(" ");
  return /next(?:\/dist|\/bin)|next-server/.test(args);
}

/**
 * Call from Prisma singletons. Local/dev Next must not use Neon.
 * Deployed production app may use Neon.
 */
export function assertAppDatabaseUrl(url: string | undefined | null): void {
  if (!url) return;
  if (isDeployedAppRuntime()) return;
  if (isProductionDatabaseUrl(url)) {
    throw new Error(
      "⛔ 로컬/에이전트 런타임이 production DATABASE_URL 을 사용합니다. caddy_local 만 허용."
    );
  }
}

export function localFixtureDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    "postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public"
  );
}

/**
 * Browser fixture / seed helper. Future dates (2099) on production are still forbidden.
 */
export function assertLocalFixtureDatabase(url: string | undefined | null): string {
  return assertLocalDatabaseUrl(
    url,
    "browser fixture/seed는 local/test DB만 허용 (production Neon 금지, 2099 날짜라도 동일)"
  );
}
