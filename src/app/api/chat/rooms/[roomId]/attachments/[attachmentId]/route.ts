import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError } from "@/lib/chatAuth";
import { requireChatPhotoRoomAccess } from "@/lib/chatPhotoAccess";
import { loadChatPhotoMeta, openChatPhotoBody } from "@/lib/chatPhoto";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  formatPhotoServerTiming,
  photoObjectToResponseBody,
  privatePhotoStreamHeaders,
} from "@/lib/photoObjectBody";
import {
  buildPrivatePhotoETag,
  ifNoneMatchContains,
  privatePhotoCacheHeaders,
} from "@/lib/privatePhotoCache";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ roomId: string; attachmentId: string }> }
) {
  const started = performance.now();
  try {
    const auth = await resolveAuthUser(req);
    const authMs = performance.now() - started;
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const params = await ctx.params;
    const roomId = decodeURIComponent(params.roomId || "");
    const attachmentId = decodeURIComponent(params.attachmentId || "");
    await requireChatPhotoRoomAccess(prisma, auth, roomId);

    const afterAuth = performance.now();
    const photo = await loadChatPhotoMeta(prisma, { roomId, attachmentId });
    const dbMs = performance.now() - afterAuth;
    const etag = buildPrivatePhotoETag("c", {
      id: photo.id,
      size: photo.size,
      storageKey: photo.storageKey,
    });
    const timing = formatPhotoServerTiming({ auth: authMs, db: dbMs });
    if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ...privatePhotoCacheHeaders(etag),
          "Server-Timing": timing,
        },
      });
    }
    const blobStarted = performance.now();
    const body = await openChatPhotoBody(photo.storageKey, req.signal);
    return new NextResponse(photoObjectToResponseBody(body), {
      status: 200,
      headers: privatePhotoStreamHeaders(etag, photo.mimeType, body, {
        "Server-Timing": formatPhotoServerTiming({
          auth: authMs,
          db: dbMs,
          blob_open: performance.now() - blobStarted,
        }),
      }),
    });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
