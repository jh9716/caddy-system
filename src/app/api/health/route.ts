// src/app/api/health/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.VERCEL ? "vercel" : "local",
  });
}
