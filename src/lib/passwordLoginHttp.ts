import { NextResponse } from "next/server";

export const PASSWORD_LOGIN_FAIL_MESSAGE =
  "아이디 또는 비밀번호를 확인해주세요.";
export const PASSWORD_LOGIN_RATE_MESSAGE =
  "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";

export function passwordLoginUnauthorizedResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "unauthorized",
      message: PASSWORD_LOGIN_FAIL_MESSAGE,
    },
    { status: 401 }
  );
}

export function passwordLoginRateLimitedResponse(
  retryAfterSec: number
): NextResponse {
  const retry = Number.isFinite(retryAfterSec)
    ? Math.max(1, Math.floor(retryAfterSec))
    : 60;
  const res = NextResponse.json(
    {
      ok: false,
      error: "rate_limited",
      message: PASSWORD_LOGIN_RATE_MESSAGE,
    },
    { status: 429 }
  );
  res.headers.set("Retry-After", String(retry));
  return res;
}
