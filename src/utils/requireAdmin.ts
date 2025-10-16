// src/utils/requireAdmin.ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

/** API 라우트에서 관리자 권한 확인 */
export async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const role = (session as any)?.user?.role?.toString().toLowerCase();

  if (role !== "admin") {
    const err: any = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
  return session;
}
