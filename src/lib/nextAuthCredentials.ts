/**
 * NextAuth Credentials authorize — same C6/C7 passwordLogin + claim-first.
 * NextAuth cannot emit HTTP 429 from authorize; limited attempts return null
 * (same generic CredentialsSignin as a bad password) and skip bcrypt.
 */

import { prisma } from "@/lib/prisma";
import { passwordLogin } from "@/lib/passwordLogin";
import {
  claimPasswordLoginAttempt,
  loginRateIpFromAuthHeaders,
  releasePasswordLoginClaim,
} from "@/lib/passwordLoginRateLimit";

export type NextAuthCredentialsUser = {
  id: string;
  name: string;
  role: string;
};

export async function authorizePasswordCredentials(
  creds: { username?: unknown; password?: unknown } | undefined,
  req?: { headers?: unknown }
): Promise<NextAuthCredentialsUser | null> {
  const username = String(creds?.username ?? "").trim();
  const password = String(creds?.password ?? "");
  if (!username || !password) return null;

  const ip = loginRateIpFromAuthHeaders(req?.headers);
  const claim = await claimPasswordLoginAttempt(prisma, { ip, username });
  if (claim.limited) return null;

  const result = await passwordLogin(username, password, prisma);
  if (result.status === "unavailable") {
    await releasePasswordLoginClaim(prisma, claim.claimId);
    throw new Error("auth_unavailable");
  }
  if (result.status !== "ok") return null;

  await releasePasswordLoginClaim(prisma, claim.claimId);

  if (result.source === "env") {
    return {
      id: result.role === "admin" ? "env-admin" : "env-caddy",
      name: result.username,
      role: result.role,
    };
  }
  return {
    id: String(result.userId),
    name: result.username,
    role: result.role,
  };
}
