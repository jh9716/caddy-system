import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "@/lib/autoAssignEngine";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import { parseReservationWorkbook } from "@/lib/reservationImportXlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — 자동배치 v1 preview (DB write 없음)
 *
 * 1) multipart: date + file(xlsx) → 가용 DB 로드 + 예약 파싱 + 배치
 * 2) JSON: { date, reservations, available, special? } → 순수 배치만
 */
export async function POST(req: NextRequest) {
  const guard = requireAdmin(req);
  if (guard) return guard;

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const date = String(form.get("date") || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return NextResponse.json(
          { error: "date=YYYY-MM-DD 필요" },
          { status: 400 }
        );
      }

      const file = form.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: "예약 엑셀 file 필요" },
          { status: 400 }
        );
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const parsed = parseReservationWorkbook(buf, {
        filename: file.name || "reservation.xlsx",
        defaultDate: date,
      });

      const availability = await loadAvailabilityForDate(date);
      const reservations: AutoAssignReservation[] = parsed.reservations.filter(
        (r) => !r.date || r.date === date
      );

      const result = computeAutoAssignmentsV1({
        date,
        reservations,
        available: availability.available.all,
        special: availability.special,
      });

      return NextResponse.json({
        mode: "file+db-availability",
        filename: file.name,
        reservationParse: {
          summary: parsed.summary,
          warnings: parsed.warnings,
          needsReviewCount: parsed.needsReview.length,
        },
        availabilityCounts: availability.counts,
        ...result,
      });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "multipart 또는 JSON body 필요" },
        { status: 400 }
      );
    }

    const date = String(body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json(
        { error: "date=YYYY-MM-DD 필요" },
        { status: 400 }
      );
    }

    const reservations = (body.reservations || []) as AutoAssignReservation[];
    let available = (body.available || []) as AutoAssignCaddy[];
    let special = (body.special || []) as AutoAssignCaddy[];

    // available 생략 시 DB에서 로드 (읽기 전용)
    if (!Array.isArray(body.available)) {
      const availability = await loadAvailabilityForDate(date);
      available = availability.available.all;
      if (!Array.isArray(body.special)) {
        special = availability.special;
      }
    }

    const result = computeAutoAssignmentsV1({
      date,
      reservations,
      available,
      special,
    });

    return NextResponse.json({
      mode: Array.isArray(body.available) ? "json" : "json+db-availability",
      ...result,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "preview 실패";
    console.error("[POST /api/assignments/preview]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
