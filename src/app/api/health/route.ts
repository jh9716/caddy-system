// src/app/api/health/route.ts
import { NextResponse } from "next/server";
import { getCourseReportPhotoStorageAuthStatus } from "@/lib/courseReportPhotoStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const blob = getCourseReportPhotoStorageAuthStatus();
  return NextResponse.json({
    ok: true,
    time: new Date().toISOString(),
    env: process.env.VERCEL ? "vercel" : "local",
    blob,
  });
}
