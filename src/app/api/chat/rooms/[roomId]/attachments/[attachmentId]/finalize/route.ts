import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError } from "@/lib/chatAuth";
import { chatPhotoIdentityMatchesReceipt, requireChatPhotoRoomAccess } from "@/lib/chatPhotoAccess";
import { finalizeChatPhotoUpload } from "@/lib/chatPhoto";
import { createChatPhotoHotpathClock, logChatPhotoHotpath } from "@/lib/chatPhotoHotpath";
import { canShowChatPhotoDebug } from "@/lib/chatPhotoTiming";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { chatMediaSecret, verifyChatMediaUploadReceipt } from "@/lib/chatPhotoR2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readUploadReceipt(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const receipt = (body as { receipt?: unknown }).receipt;
  return typeof receipt === "string" ? receipt.trim() : "";
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string; attachmentId: string }> }
) {
  const clock = createChatPhotoHotpathClock();
  try {
    const auth = await resolveAuthUser(req);
    clock.mark("auth");
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const params = await ctx.params;
    const roomId = decodeURIComponent(params.roomId || "");
    const attachmentId = decodeURIComponent(params.attachmentId || "");
    const body = await req.json().catch(() => null);
    const receipt = readUploadReceipt(body);
    let senderUserId: number;
    if (receipt) {
      const verified = await verifyChatMediaUploadReceipt(chatMediaSecret(process.env), receipt);
      if (!verified.ok) {
        return NextResponse.json(
          { error: verified.code, message: "업로드 확인에 실패했습니다." },
          { status: verified.status }
        );
      }
      if (
        verified.receipt.roomId === roomId &&
        verified.receipt.attachmentId === attachmentId &&
        chatPhotoIdentityMatchesReceipt(auth, verified.receipt)
      ) {
        senderUserId = verified.receipt.senderUserId;
        clock.flag("roomAccessFastPath", true);
        clock.reason("roomAccessFallbackReason", "fast");
      } else {
        return NextResponse.json(
          { error: "invalid_receipt", message: "업로드 확인에 실패했습니다." },
          { status: 401 }
        );
      }
    } else {
      const access = await requireChatPhotoRoomAccess(prisma, auth, roomId);
      clock.mark("roomAccess");
      clock.flag("roomAccessFastPath", false);
      senderUserId = access.userId;
    }
    const photo = await finalizeChatPhotoUpload(
      prisma,
      {
        roomId,
        attachmentId,
        senderUserId,
        uploadReceipt: receipt || undefined,
      },
      clock
    );
    const hotpath = clock.summary("finalize");
    logChatPhotoHotpath(hotpath);
    const debug = canShowChatPhotoDebug({
      role: auth.role,
      search: req.nextUrl.search,
    });
    return NextResponse.json({
      ok: true,
      photo,
      ...(debug ? { hotpath } : {}),
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[POST /api/chat/rooms/attachments/finalize]", e);
    return NextResponse.json({ error: "finalize_failed" }, { status: 500 });
  }
}
