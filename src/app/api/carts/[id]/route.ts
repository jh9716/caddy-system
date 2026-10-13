import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { CartManageError } from "@/lib/cartManage";
import { getCartById, updateCart } from "@/lib/cartService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseId(raw: string | undefined) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const resolved = await Promise.resolve(params);
    return NextResponse.json(await getCartById(parseId(resolved.id)));
  } catch (e: unknown) {
    if (e instanceof CartManageError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    console.error("GET /api/carts/[id]", e);
    return NextResponse.json({ error: "불러오기 실패" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const resolved = await Promise.resolve(params);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body 필요" }, { status: 400 });
    }
    const auth = await resolveAuthUser(req);
    const updated = await updateCart(
      parseId(resolved.id),
      body as Record<string, unknown>,
      actorFrom(auth, req)
    );
    return NextResponse.json(updated);
  } catch (e: unknown) {
    if (e instanceof CartManageError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    console.error("PATCH /api/carts/[id]", e);
    return NextResponse.json({ error: "수정 실패" }, { status: 500 });
  }
}
