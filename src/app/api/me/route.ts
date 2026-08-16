import { NextRequest, NextResponse } from "next/server";
import { resolveAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await resolveAuthUser(req);
  if (!auth) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    user: {
      id: auth.userId,
      username: auth.username,
      role: auth.role,
      sessionVersion: auth.sessionVersion,
    },
  });
}
