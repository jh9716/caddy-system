import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import {
  isNoticeAuthResponse,
  loadNoticeViewer,
  requireNoticeReader,
} from "@/lib/noticeAccess";
import {
  parseNoticeSendPushFlag,
  runNoticeCreatePush,
} from "@/lib/noticeAutoPush";
import {
  cleanupNoticePhotoBlobsBestEffort,
  isNoticePhotoTableMissing,
  listNoticePhotoStorageKeys,
  listNoticePhotos,
} from "@/lib/noticePhoto";
import {
  NoticeValidationError,
  canViewNotice,
  parseNoticeWriteBody,
} from "@/lib/noticeTarget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function noticeId(
  params: Promise<{ id: string }> | { id: string }
): Promise<number> {
  const resolved = await Promise.resolve(params);
  return Number(resolved.id);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireNoticeReader(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const id = await noticeId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const notice = await prisma.notice.findUnique({ where: { id } });
  if (!notice) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const viewer = await loadNoticeViewer(prisma, auth);
  if (!canViewNotice(notice, viewer)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const photos = await listNoticePhotos(prisma, id);
    return NextResponse.json({ ...notice, photos, photoCount: photos.length });
  } catch (e) {
    if (!isNoticePhotoTableMissing(e)) throw e;
    return NextResponse.json({ ...notice, photos: [], photoCount: 0 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const id = await noticeId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await req.json().catch(() => ({}));
  try {
    const parsed = parseNoticeWriteBody(body, "update");
    const data: {
      title?: string;
      content?: string;
      important?: boolean;
      pinned?: boolean;
      targetType?: string;
      targetValue?: string | null;
      publishStartAt?: Date | null;
      publishEndAt?: Date | null;
      author?: string;
    } = {};
    if (parsed.title !== undefined) data.title = parsed.title;
    if (parsed.content !== undefined) data.content = parsed.content;
    if (parsed.important !== undefined) data.important = parsed.important;
    if (parsed.pinned !== undefined) data.pinned = parsed.pinned;
    if (parsed.targetType !== undefined) data.targetType = parsed.targetType;
    if (parsed.targetValue !== undefined) data.targetValue = parsed.targetValue;
    if (parsed.publishStartAt !== undefined) data.publishStartAt = parsed.publishStartAt;
    if (parsed.publishEndAt !== undefined) data.publishEndAt = parsed.publishEndAt;
    if (parsed.author !== undefined) data.author = parsed.author;
    const updated = await prisma.notice.update({
      where: { id },
      data,
    });
    const sendPush = parseNoticeSendPushFlag(body, false);
    if (!sendPush) {
      return NextResponse.json(updated);
    }
    const authUser = await resolveAuthUser(req);
    const push = await runNoticeCreatePush({
      db: prisma,
      noticeId: updated.id,
      requested: true,
      publishStartAt: updated.publishStartAt,
      publishEndAt: updated.publishEndAt,
      actorUserId: authUser?.userId ?? null,
    });
    return NextResponse.json({ ...updated, push });
  } catch (e) {
    if (e instanceof NoticeValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const id = await noticeId(params);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const photoKeys = await listNoticePhotoStorageKeys(prisma, id);
  await prisma.notice.delete({ where: { id } });
  const cleanup = await cleanupNoticePhotoBlobsBestEffort(photoKeys, {
    noticeId: id,
  });
  return NextResponse.json({
    ok: true,
    ...(cleanup.failed.length > 0 ? { blobCleanupFailed: true } : {}),
  });
}
