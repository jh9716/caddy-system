import { NextRequest, NextResponse } from "next/server";
import dayjs from "dayjs";
import { prisma } from "@/lib/prisma";
import {
  isNoticeAuthResponse,
  loadNoticeViewer,
  requireNoticeReader,
} from "@/lib/noticeAccess";
import { noticeListOrder, visibleNoticeWhere } from "@/lib/noticeTarget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireNoticeReader(req);
  if (isNoticeAuthResponse(auth)) return auth;

  const start = dayjs().startOf("day").toDate();
  const end = dayjs().endOf("day").toDate();

  const totalCaddies = await prisma.caddy.count();

  const [off, sick, longSick, duty, marshal] = await Promise.all([
    prisma.assignment.count({
      where: { type: "OFF", startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: "SICK", startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: "LONG_SICK", startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: "DUTY", startDate: { lte: end }, endDate: { gte: start } },
    }),
    prisma.assignment.count({
      where: { type: "MARSHAL", startDate: { lte: end }, endDate: { gte: start } },
    }),
  ]);

  const viewer = await loadNoticeViewer(prisma, auth);
  const latestNotices = await prisma.notice.findMany({
    where: visibleNoticeWhere(viewer),
    orderBy: noticeListOrder(),
    take: 5,
    select: {
      id: true,
      title: true,
      createdAt: true,
      important: true,
      pinned: true,
      targetType: true,
      targetValue: true,
    },
  });

  return NextResponse.json({
    date: dayjs().format("YYYY-MM-DD"),
    totalCaddies,
    today: { off, sick, longSick, duty, marshal },
    latestNotices,
  });
}
