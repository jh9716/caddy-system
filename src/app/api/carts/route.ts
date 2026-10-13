import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { CartManageError } from "@/lib/cartManage";
import { createCart, listCarts } from "@/lib/cartService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function actorFrom(
  auth: Awaited<ReturnType<typeof resolveAuthUser>>,
  req: NextRequest
) {
  return {
    username: auth?.username ?? null,
    userId: auth?.userId ?? null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
  };
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    return NextResponse.json({ carts: await listCarts() });
  } catch (e: unknown) {
    console.error("GET /api/carts", e);
    return NextResponse.json({ error: "불러오기 실패" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const auth = await resolveAuthUser(req);
    const created = await createCart(
      body as Record<string, unknown>,
      actorFrom(auth, req)
    );
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    if (e instanceof CartManageError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    console.error("POST /api/carts", e);
    return NextResponse.json({ error: "등록 실패" }, { status: 500 });
  }
}
