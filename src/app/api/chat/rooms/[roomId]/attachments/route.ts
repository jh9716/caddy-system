import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Phase 1 server-proxy upload removed. Bytes must not enter this Function. */
export async function POST() {
  return NextResponse.json(
    {
      error: "use_direct_upload",
      message: "사진은 직접 업로드로 전송해 주세요.",
    },
    { status: 410 }
  );
}
