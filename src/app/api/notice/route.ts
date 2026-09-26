import { NextRequest, NextResponse } from "next/server";
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
import { isNoticePhotoTableMissing } from "@/lib/noticePhoto";
import {
  NoticeValidationError,
  noticeListOrder,
  parseNoticeWriteBody,
  visibleNoticeWhere,
} from "@/lib/noticeTarget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireNoticeReader(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const viewer = await loadNoticeViewer(prisma, auth);
  try {
    const list = await prisma.notice.findMany({
      where: visibleNoticeWhere(viewer),
      orderBy: noticeListOrder(),
      include: { _count: { select: { photos: true } } },
    });
    return NextResponse.json(
      list.map(({ _count, ...row }) => ({ ...row, photoCount: _count.photos }))
    );
  } catch (e) {
    if (!isNoticePhotoTableMissing(e)) throw e;
    const list = await prisma.notice.findMany({
      where: visibleNoticeWhere(viewer),
      orderBy: noticeListOrder(),
    });
    return NextResponse.json(list.map((row) => ({ ...row, photoCount: 0 })));
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const body = await req.json().catch(() => ({}));
  try {
    const parsed = parseNoticeWriteBody(body, "create");
    const n = await prisma.notice.create({
      data: {
        title: parsed.title ?? "",
        content: parsed.content ?? "",
        author: parsed.author ?? null,
        important: parsed.important ?? false,
        pinned: parsed.pinned ?? false,
        targetType: parsed.targetType ?? "ALL",
        targetValue: parsed.targetValue ?? null,
        publishStartAt: parsed.publishStartAt ?? null,
        publishEndAt: parsed.publishEndAt ?? null,
      },
    });
    const auth = await resolveAuthUser(req);
    const push = await runNoticeCreatePush({
      db: prisma,
      noticeId: n.id,
      requested: parseNoticeSendPushFlag(body, false),
      publishStartAt: n.publishStartAt,
      publishEndAt: n.publishEndAt,
      actorUserId: auth?.userId ?? null,
    });
    return NextResponse.json({ ok: true, id: n.id, push });
  } catch (e) {
    if (e instanceof NoticeValidationError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
