import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await cookies();
  const role = store.get("role")?.value ?? null;
  return NextResponse.json({ role });
}
