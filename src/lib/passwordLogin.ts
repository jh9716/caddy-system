import type { AppRole } from "@/lib/sessionCookies";
import { normalizeAppRole } from "@/lib/sessionCookies";
import { matchEnvOnlyAccount } from "@/lib/envCredentials";
import { verifyUserPassword } from "@/lib/userPassword";

export type PasswordLoginUser = {
  id: number;
  username: string;
  password: string | null;
  role: string;
  sessionVersion?: number | null;
  mustChangePassword?: boolean | null;
};

export type PasswordLoginDb = {
  user: {
    findUnique: (args: {
      where: { username: string };
    }) => Promise<PasswordLoginUser | null>;
  };
};

export type PasswordLoginResult =
  | {
      status: "ok";
      source: "env" | "db";
      username: string;
      role: AppRole;
      userId: number | null;
      sessionVersion: number;
      mustChangePassword: boolean;
    }
  | { status: "unauthorized"; reason: "not_found" | "bad_password" | "bad_role" }
  | { status: "unavailable" };

/**
 * Env-only account (if password env is set) then DB User bcrypt.
 * Thrown DB/schema errors → unavailable (caller maps to 500, logs details).
 * Unknown user / bad password / unusable role → unauthorized (401).
 */
export async function passwordLogin(
  username: string,
  password: string,
  db: PasswordLoginDb
): Promise<PasswordLoginResult> {
  const user = String(username ?? "").trim();
  const pass = String(password ?? "");
  if (!user || !pass) {
    return { status: "unauthorized", reason: "not_found" };
  }

  const env = matchEnvOnlyAccount(user, pass);
  if (env) {
    return {
      status: "ok",
      source: "env",
      username: env.username,
      role: env.role,
      userId: null,
      sessionVersion: 0,
      mustChangePassword: false,
    };
  }

  try {
    const row = await db.user.findUnique({ where: { username: user } });
    if (!row) return { status: "unauthorized", reason: "not_found" };
    const ok = await verifyUserPassword(pass, row.password);
    if (!ok) return { status: "unauthorized", reason: "bad_password" };
    const role = normalizeAppRole(row.role);
    if (!role) return { status: "unauthorized", reason: "bad_role" };
    return {
      status: "ok",
      source: "db",
      username: row.username,
      role,
      userId: row.id,
      sessionVersion: row.sessionVersion ?? 0,
      mustChangePassword: row.mustChangePassword === true,
    };
  } catch (e) {
    console.error("[passwordLogin] db auth error", e);
    return { status: "unavailable" };
  }
}
