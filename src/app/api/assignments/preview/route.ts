import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "@/lib/autoAssignEngine";
import type { AvailabilityRow } from "@/lib/availabilityEngine";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import { parseReservationWorkbook } from "@/lib/reservationImportXlsx";

/** special 태그/라벨에 54홀 힌트가 있으면 54홀 후보로 추출 */
function extractFiftyFourHoleCandidates(
  special: AvailabilityRow[],
  explicit?: AutoAssignCaddy[] | null
): AutoAssignCaddy[] {
  if (Array.isArray(explicit)) return explicit;
  return special.filter((row) => {
    const marks = [...(row.specialTags || []), ...(row.assignmentLabels || [])];
    return marks.some((t) => /54|54홀|오십사/.test(String(t)));
  });
}

/** 1·3부 신청 힌트 (54홀과 겹치면 compute 쪽에서 54 우선) */
function extractOneThreeCandidates(
  special: AvailabilityRow[],
  explicit?: AutoAssignCaddy[] | null
): AutoAssignCaddy[] {
  if (Array.isArray(explicit)) return explicit;
  return special.filter((row) => {
    const marks = [...(row.specialTags || []), ...(row.assignmentLabels || [])];
    return marks.some((t) => {
      const s = String(t);
      if (/54|54홀/.test(s)) return false;
      return /1\s*[·・.]?\s*3\s*부|1·3|1\.3부|ONE_THREE|13부/.test(s);
    });
  });
}

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
      const fiftyFourHole = extractFiftyFourHoleCandidates(availability.special);
      const oneThreeCandidates = extractOneThreeCandidates(availability.special);

      const result = computeAutoAssignmentsV1({
        date,
        reservations,
        available: availability.available.all,
        special: availability.special,
        fiftyFourHole,
        oneThreeCandidates,
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
    let specialRows: AvailabilityRow[] = [];

    // available 생략 시 DB에서 로드 (읽기 전용)
    if (!Array.isArray(body.available)) {
      const availability = await loadAvailabilityForDate(date);
      available = availability.available.all;
      if (!Array.isArray(body.special)) {
        special = availability.special;
        specialRows = availability.special;
      }
    }

    const fiftyFourHole = extractFiftyFourHoleCandidates(
      specialRows,
      Array.isArray(body.fiftyFourHole) ? body.fiftyFourHole : null
    );
    const oneThreeCandidates = extractOneThreeCandidates(
      specialRows,
      Array.isArray(body.oneThreeCandidates) ? body.oneThreeCandidates : null
    );

    const result = computeAutoAssignmentsV1({
      date,
      reservations,
      available,
      special,
      fiftyFourHole,
      oneThreeCandidates,
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
