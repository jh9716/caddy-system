import { NextRequest, NextResponse, after } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError } from "@/lib/chatAuth";
import { resolveChatPhotoRoomAccess } from "@/lib/chatPhotoAccess";
import { prepareChatPhotoUpload, runChatAttachmentMaintenance } from "@/lib/chatPhoto";
import {
  createChatPhotoHotpathClock,
  logChatPhotoHotpath,
  shouldRunBackgroundChatPhotoCleanup,
} from "@/lib/chatPhotoHotpath";
import { canShowChatPhotoDebug } from "@/lib/chatPhotoTiming";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string }> }
) {
  const clock = createChatPhotoHotpathClock();
  try {
    const auth = await resolveAuthUser(req);
    clock.mark("auth");
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const roomId = decodeURIComponent((await ctx.params).roomId || "");
    const body = (await req.json().catch(() => null)) as {
      contentType?: unknown;
      size?: unknown;
      chatToken?: unknown;
    } | null;
    const access = await resolveChatPhotoRoomAccess(prisma, auth, roomId, {
      chatToken: typeof body?.chatToken === "string" ? body.chatToken : "",
    });
    // ALL-room local HMAC. Env-admin userId=null still matches a verified admin token.
    clock.mark("roomAccess");
    clock.flag("roomAccessFastPath", access.fastPath);
    clock.reason("roomAccessFallbackReason", access.fallbackReason);
    const upload = await prepareChatPhotoUpload(
      prisma,
      {
        roomId,
        senderUserId: access.userId,
        contentType: body?.contentType,
        size: body?.size,
      },
      clock
    );
    const hotpath = clock.summary("prepare");
    logChatPhotoHotpath(hotpath);
    if (shouldRunBackgroundChatPhotoCleanup()) {
      try {
        after(() => {
          void runChatAttachmentMaintenance(prisma);
        });
      } catch {
        /* after() needs a Next request scope */
      }
    }
    const debug = canShowChatPhotoDebug({
      role: auth.role,
      search: req.nextUrl.search,
    });
    return NextResponse.json({
      ok: true,
      upload,
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
    console.error("[POST /api/chat/rooms/attachments/prepare]", e);
    return NextResponse.json({ error: "prepare_failed" }, { status: 500 });
  }
}
