import { cache } from "react";
import { cookies } from "next/headers";
import { resolveAuthFromCookieStore } from "@/lib/auth";

/**
 * One signed-session + User/sessionVersion lookup per RSC request.
 * Does not skip signature, sessionVersion, or role checks.
 */
export const getRequestAuthUser = cache(async () => {
  return resolveAuthFromCookieStore(await cookies());
});
