/**
 * TEMPORARY GET-only Preview isolation probe for PR #371.
 * Remove before merging to main. No DB/Blob I/O. Response is four booleans.
 */
import { NextResponse } from "next/server";
import {
  inspectPreviewIsolation,
  previewIsolationEnabled,
} from "@/lib/previewIsolationDiag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  if (!previewIsolationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const { previewRuntime, previewDbMatch, previewBlobMatch, safeToTest } =
    inspectPreviewIsolation();

  return NextResponse.json(
    { previewRuntime, previewDbMatch, previewBlobMatch, safeToTest },
    { status: 200, headers: NO_STORE }
  );
}
