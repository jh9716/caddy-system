/**
 * TEMPORARY admin diagnostic for PR #368. Delete with src/lib/previewDbProbe.ts
 * after Preview Neon identity is confirmed.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  classifyPreviewDbIdentity,
  evaluatePreviewDbProbeGate,
} from "@/lib/previewDbProbe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function notFound() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(req: NextRequest) {
  const gate = evaluatePreviewDbProbeGate(process.env);
  if (!gate.allowQuery) return notFound();

  const { requireAdmin } = await import("@/lib/auth");
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const { prisma } = await import("@/lib/prisma");
    const rows = await prisma.$queryRaw<
      Array<{ neon_endpoint: string | null; database: string | null }>
    >`
      SELECT current_setting('neon.endpoint_id', true) AS neon_endpoint,
             current_database() AS database
    `;
    const classified = classifyPreviewDbIdentity({
      neonEndpoint: rows[0]?.neon_endpoint,
      database: rows[0]?.database,
    });
    return NextResponse.json({
      ok: true,
      temporary: true,
      match: classified.match,
      endpointMatch: classified.endpointMatch,
      databaseMatch: classified.databaseMatch,
    });
  } catch {
    return NextResponse.json({ ok: false, error: "probe_failed" }, { status: 503 });
  }
}
