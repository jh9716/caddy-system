import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/utils/requireAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  const list = await prisma.notice.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  await requireAdmin(); // 관리자만
  const { title, content } = await req.json();
  if (!title || String(title).trim() === "") {
    return NextResponse.json({ error: "제목은 필수입니다." }, { status: 400 });
  }
  const n = await prisma.notice.create({
    data: { title: String(title), content: content ? String(content) : "" },
  });
  return NextResponse.json({ ok: true, id: n.id });
}
