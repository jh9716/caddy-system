import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError } from "@/lib/chatAuth";
import { requireChatPhotoRoomAccess } from "@/lib/chatPhotoAccess";
import { uploadChatPhoto } from "@/lib/chatPhoto";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readUploadBytes(req: NextRequest): Promise<Uint8Array> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  return new Uint8Array(buf);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> }
) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const roomId = decodeURIComponent((await ctx.params).roomId || "");
    const access = await requireChatPhotoRoomAccess(prisma, auth, roomId);
    const bytes = await readUploadBytes(req);
    const photo = await uploadChatPhoto(prisma, {
      roomId,
      senderUserId: access.userId,
      bytes,
    });
    return NextResponse.json({ ok: true, photo });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[POST /api/chat/rooms/attachments]", e);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }
}
