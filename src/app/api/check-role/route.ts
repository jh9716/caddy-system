import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await cookies();
  const session = await getVerifiedSessionFromCookies(store);
  return NextResponse.json({ role: session?.role ?? null });
}
