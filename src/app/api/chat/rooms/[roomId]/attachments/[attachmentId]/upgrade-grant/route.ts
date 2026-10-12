import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError } from "@/lib/chatAuth";
import { requireChatPhotoRoomAccess } from "@/lib/chatPhotoAccess";
import { prepareChatPhotoUpgrade } from "@/lib/chatPhoto";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string; attachmentId: string }> }
) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const params = await ctx.params;
    const roomId = decodeURIComponent(params.roomId || "");
    const attachmentId = decodeURIComponent(params.attachmentId || "");
    const access = await requireChatPhotoRoomAccess(prisma, auth, roomId);
    const upload = await prepareChatPhotoUpgrade(prisma, {
      roomId,
      attachmentId,
      senderUserId: access.userId,
    });
    return NextResponse.json({ ok: true, upload });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[POST /api/chat/rooms/attachments/upgrade-grant]", e);
    return NextResponse.json({ error: "upgrade_grant_failed" }, { status: 500 });
  }
}
