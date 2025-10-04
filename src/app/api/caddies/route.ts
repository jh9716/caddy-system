// src/app/api/caddies/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/caddies : 전체 목록
export async function GET() {
  try {
    const list = await prisma.caddy.findMany({
      orderBy: { id: "asc" },
    });
    return NextResponse.json(list);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

// POST /api/caddies : 생성
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, team, status } = body ?? {};
    if (!name || !team || !status) {
      return NextResponse.json(
        { error: "name, team, status는 필수입니다." },
        { status: 400 }
      );
    }
    const created = await prisma.caddy.create({
      data: { name, team, status },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Failed to create" }, { status: 500 });
  }
}
