import { NextRequest, NextResponse } from "next/server";
import { putLocalChatPhotoBytes } from "@/lib/chatPhoto";
import { verifyLocalChatPhotoPutToken } from "@/lib/chatPhotoSignedPut";
import { getChatAuthSecret } from "@/lib/chatToken";
import { CourseReportPhotoValidationError } from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Local/dev stand-in for a Private Blob signed PUT.
 * Production/Vercel always 404 — photo bytes never use this on Vercel.
 */
export async function PUT(req: NextRequest) {
  if (process.env.VERCEL === "1") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  try {
    const token = req.nextUrl.searchParams.get("token") || "";
    const grant = verifyLocalChatPhotoPutToken(getChatAuthSecret(), token);
    const contentType = (req.headers.get("content-type") || "").toLowerCase().split(";", 1)[0];
    if (contentType !== grant.contentType) {
      throw new CourseReportPhotoValidationError(
        "unsupported_type",
        "JPG/PNG/WEBP 형식으로 첨부해 주세요."
      );
    }
    const buf = await req.arrayBuffer().catch(() => null);
    if (!buf || buf.byteLength === 0) {
      throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
    }
    if (buf.byteLength > grant.maxBytes) {
      throw new CourseReportPhotoValidationError(
        "file_too_large",
        "사진은 장당 3MB 이하만 첨부할 수 있습니다."
      );
    }
    await putLocalChatPhotoBytes({
      storageKey: grant.storageKey,
      contentType: grant.contentType,
      bytes: new Uint8Array(buf),
    });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError || e instanceof CourseReportPhotoStorageError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    console.error("[PUT /api/chat/local-blob-put]", e);
    return NextResponse.json({ error: "upload_failed" }, { status: 500 });
  }
}
