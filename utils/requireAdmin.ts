import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/authOptions";
import { getSessionRole, isAdminRole } from "@/lib/roles";

type GuardFail = { ok: false; status: 401 | 403 };
type GuardOk = { ok: true; session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>; role: "admin" };

export async function requireAdmin(): Promise<GuardOk | GuardFail> {
  const session = await getServerSession(authOptions);
  const role = getSessionRole(session);

  if (!session?.user) return { ok: false, status: 401 };
  if (!isAdminRole(role)) return { ok: false, status: 403 };

  return { ok: true, session, role: "admin" };
}

export function adminGuardResponse(result: GuardFail) {
  return NextResponse.json(
    { error: result.status === 401 ? "unauthorized" : "forbidden" },
    { status: result.status }
  );
}
