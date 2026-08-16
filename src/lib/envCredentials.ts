/**
 * Env-only ID/PW accounts (uid null, sessionVersion 0).
 *
 * Runtime policy:
 * - ADMIN_PASSWORD / CADDY_PASSWORD must be set to a non-empty value.
 * - If the password env is missing or empty, that env-only account is disabled.
 * - Never fall back to source-coded default passwords.
 */

function readEnv(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

export type EnvOnlyAccount = {
  username: string;
  password: string;
  role: "admin" | "caddy";
};

export function getEnvOnlyAdmin(): EnvOnlyAccount | null {
  const password = readEnv("ADMIN_PASSWORD");
  if (!password) return null;
  const username =
    readEnv("ADMIN_USER") || readEnv("ADMIN_USERNAME") || "admin";
  return { username, password, role: "admin" };
}

export function getEnvOnlyCaddy(): EnvOnlyAccount | null {
  const password = readEnv("CADDY_PASSWORD");
  if (!password) return null;
  const username =
    readEnv("CADDY_USER") || readEnv("CADDY_USERNAME") || "caddy";
  return { username, password, role: "caddy" };
}

export function matchEnvOnlyAccount(
  username: string,
  password: string
): EnvOnlyAccount | null {
  if (!username || !password) return null;
  const admin = getEnvOnlyAdmin();
  if (admin && username === admin.username && password === admin.password) {
    return admin;
  }
  const caddy = getEnvOnlyCaddy();
  if (caddy && username === caddy.username && password === caddy.password) {
    return caddy;
  }
  return null;
}
