import { NextRequest, NextResponse } from "next/server";
import {
  AccountDeletionRequestError,
  clientIpFromRequest,
  createAccountDeletionRequest,
} from "@/lib/accountDeletionRequest";
import {
  createPrivacyInquiryRequest,
  parsePrivacyInquiryRequest,
  publicPrivacyInquiryAcceptedBody,
} from "@/lib/privacyInquiryRequest";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = parsePrivacyInquiryRequest(body);
    const ip = clientIpFromRequest(req.headers);
    if (parsed.kind === "deletion") {
      await createAccountDeletionRequest(prisma, parsed.input, { ip });
    } else {
      await createPrivacyInquiryRequest(prisma, parsed.input, { ip });
    }
    return NextResponse.json(publicPrivacyInquiryAcceptedBody());
  } catch (e) {
    if (e instanceof AccountDeletionRequestError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.status }
      );
    }
    console.error("[POST /api/privacy-inquiries]");
    return NextResponse.json(
      { error: "internal_error", message: "요청 처리에 실패했습니다." },
      { status: 500 }
    );
  }
}
