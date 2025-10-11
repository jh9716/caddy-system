import { auth } from "@/lib/serverSession";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.notice.findMany({
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
  });
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 관리자만 작성
  const me = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!me || (me.role !== "ADMIN" && me.role !== "MANAGER"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { title, body, pinned = false } = await req.json();
  const created = await prisma.notice.create({
    data: { title, body, pinned, authorId: me.id },
  });
  return NextResponse.json(created, { status: 201 });
}
