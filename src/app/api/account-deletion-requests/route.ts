import { NextRequest, NextResponse } from "next/server";
import {
  AccountDeletionRequestError,
  clientIpFromRequest,
  createAccountDeletionRequest,
  parseAccountDeletionRequest,
  publicDeletionAcceptedBody,
} from "@/lib/accountDeletionRequest";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const input = parseAccountDeletionRequest(body);
    await createAccountDeletionRequest(prisma, input, {
      ip: clientIpFromRequest(req.headers),
    });
    return NextResponse.json(publicDeletionAcceptedBody());
  } catch (e) {
    if (e instanceof AccountDeletionRequestError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[POST /api/account-deletion-requests]");
    return NextResponse.json(
      { error: "internal_error", message: "요청 처리에 실패했습니다." },
      { status: 500 }
    );
  }
}
