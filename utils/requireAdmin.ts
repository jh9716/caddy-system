// utils/requireAdmin.ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/authOptions";

// 관리자 또는 매니저만 통과
export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const role = (session as any)?.role || "STAFF";

  if (!session?.user) return { ok: false, status: 401 as const };
  if (!["ADMIN", "MANAGER"].includes(role)) return { ok: false, status: 403 as const };

  return { ok: true as const, session };
}
