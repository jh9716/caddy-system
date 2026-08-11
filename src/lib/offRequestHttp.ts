import { NextResponse } from "next/server";
import { OffRequestServiceError } from "@/lib/offRequestService";

export function offRequestErrorResponse(e: unknown): NextResponse {
  if (e instanceof OffRequestServiceError) {
    return NextResponse.json(
      {
        error: e.code,
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      },
      { status: e.status }
    );
  }
  if (e instanceof Error && /date must be YYYY-MM-DD|invalid date/i.test(e.message)) {
    return NextResponse.json(
      { error: "invalid_date", message: e.message },
      { status: 400 }
    );
  }
  console.error("[off-requests]", e);
  return NextResponse.json(
    { error: "internal_error", message: "요청 처리 중 오류가 발생했습니다." },
    { status: 500 }
  );
}
