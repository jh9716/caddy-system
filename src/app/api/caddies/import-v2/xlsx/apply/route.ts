import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, resolveAuthUser } from "@/lib/auth";
import { canReadArchivedCaddies } from "@/lib/caddyArchiveVisibility";
import {
  applyXlsxV2Workbook,
  XlsxV2ApplyError,
  xlsxV2ApplySuccessMessage,
} from "@/lib/caddyRosterImportXlsxV2Apply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

const MAX_UPLOAD_BYTES = 2_000_000;

/**
 * POST /api/caddies/import-v2/xlsx/apply
 * P2와 같은 parser로 재검증 후 한 transaction으로만 반영.
 * 자동 적용 없음. 미리보기 fingerprint 필수.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  try {
    const form = await req.formData();
    const file = form.get("file");
    const fingerprintRaw = form.get("fingerprint");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file 필요" }, { status: 400 });
    }
    const filename = file.name || "roster.xlsx";
    if (!/\.xlsx$/i.test(filename)) {
      return NextResponse.json(
        { error: "P1 export.xlsx 형식(.xlsx)만 적용합니다." },
        { status: 400 }
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "파일이 너무 큽니다. 2MB 이하만 올립니다." },
        { status: 400 }
      );
    }
    const fingerprint =
      typeof fingerprintRaw === "string" ? fingerprintRaw.trim() : "";

    const buffer = Buffer.from(await file.arrayBuffer());
    const auth = await resolveAuthUser(req);
    const result = await applyXlsxV2Workbook(
      {
        buffer,
        fingerprint,
        canReadArchived: canReadArchivedCaddies(auth),
        actorUserId: auth?.userId ?? null,
      },
      prisma
    );

    return NextResponse.json({
      ...result,
      message: xlsxV2ApplySuccessMessage(result),
    });
  } catch (e: unknown) {
    if (e instanceof XlsxV2ApplyError) {
      return NextResponse.json(
        {
          error: e.message,
          code: e.code,
          preview: e.preview ?? null,
        },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "apply 실패";
    console.error("[POST /api/caddies/import-v2/xlsx/apply]", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
