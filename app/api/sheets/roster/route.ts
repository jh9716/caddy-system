import { NextResponse } from "next/server";
// import { getSheets } from "@/lib/google"; // 나중에 활성화

export async function GET() {
  // 나중에: const sheets = await getSheets(); 값 읽기
  return NextResponse.json({ ok: true, rows: [] });
}
