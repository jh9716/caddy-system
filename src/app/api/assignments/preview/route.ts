import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  computeAutoAssignmentsV1,
  HouseStartCaddyError,
  parseOptionalThirdStartCaddyId,
  ThirdStartCaddyError,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type FixedAssignmentInput,
  type SpecialStartAnchor,
} from "@/lib/autoAssignEngine";
import type { AvailabilityRow } from "@/lib/availabilityEngine";
import { loadAvailabilityForDate } from "@/lib/availabilityService";
import { parseReservationWorkbook } from "@/lib/reservationImportXlsx";
import { OffSheetError } from "@/lib/offSheetFetch";
import { DutyExcelError } from "@/lib/dutyMarshalLeaderParser";
import {
  applyBundlesToAssignPools,
  unavailableReasonsFromRows,
  type EngineSpecialBundles,
} from "@/lib/dailySpecialDuty";
import {
  loadEngineSpecialBundlesForDate,
  resolveDailySpecialPlacement,
} from "@/lib/dailySpecialDutyService";
import { isThirdWeeklyTeam } from "@/lib/thirdWeeklyRotation";
import { loadEffectiveThirdStartTeam } from "@/lib/thirdWeeklyStartService";
import { regularPoolExcludingStoredOpsDuty } from "@/lib/opsDutyLivePool";
import { loadSpecialSupportQueuesForDate } from "@/lib/dailySpecialSupportService";
import { stampReservationIdentities } from "@/lib/reservationIdentity";

function parseThirdStartTeam(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return isThirdWeeklyTeam(value) ? value : null;
}

async function resolvePreviewThirdStartTeam(
  date: string,
  explicit: unknown
): Promise<string> {
  return parseThirdStartTeam(explicit) ?? loadEffectiveThirdStartTeam(date);
}

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

/** 1·2부 신청 힌트 (상위 우선순위와 겹치면 compute 쪽에서 제외) */
function extractOneTwoCandidates(
  special: AvailabilityRow[],
  explicit?: AutoAssignCaddy[] | null
): AutoAssignCaddy[] {
  if (Array.isArray(explicit)) return explicit;
  return special.filter((row) => {
    const marks = [...(row.specialTags || []), ...(row.assignmentLabels || [])];
    return marks.some((t) => {
      const s = String(t);
      if (/54|54홀/.test(s)) return false;
      if (/1\s*[·・.]?\s*3\s*부|1·3|ONE_THREE/.test(s)) return false;
      return /1\s*[·・.]?\s*2\s*부|1·2|1\.2부|ONE_TWO|12부/.test(s);
    });
  });
}

function parseSpecialAnchor(raw: unknown): SpecialStartAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const course = String((raw as { course?: unknown }).course || "").trim();
  const teeTime = String((raw as { teeTime?: unknown }).teeTime || "").trim();
  if (!course || !teeTime) return null;
  return { course, teeTime };
}

function availabilityRowsToCaddies(
  rows: AvailabilityRow[] | AutoAssignCaddy[] | undefined
): AutoAssignCaddy[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: Number(row.teamOrder) || 0,
    caddyType: row.caddyType,
    extraFlags: "extraFlags" in row ? row.extraFlags ?? null : null,
    thirdBandSubgroup:
      "thirdBandSubgroup" in row ? row.thirdBandSubgroup ?? null : null,
    employmentStatus:
      "employmentStatus" in row ? row.employmentStatus ?? undefined : undefined,
  }));
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
  const guard = await requireAdmin(req);
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

      let dutyWorkbook: Buffer | null = null;
      const dutyFile = form.get("dutyFile");
      if (dutyFile && dutyFile instanceof File) {
        dutyWorkbook = Buffer.from(await dutyFile.arrayBuffer());
      }
      const availability = await loadAvailabilityForDate(date, { dutyWorkbook });
      const reservations: AutoAssignReservation[] = stampReservationIdentities(
        parsed.reservations
          .filter((r) => !r.date || r.date === date)
          .map((r) => ({
            date: r.date,
            course: r.course || "",
            courseLabel: r.courseLabel,
            shift: r.shift || "",
            teeTime: r.teeTime,
            teamName: r.teamName,
            hole: r.hole,
            startingHole: r.startingHole,
            sourceSheet: r.sourceSheet,
            rawRowIndex: r.rawRowIndex,
            needsReview: r.needsReview,
            isDuplicate: r.isDuplicate,
            reviewReasons: r.reviewReasons,
          }))
      );
      const unavailable = unavailableReasonsFromRows(availability.excluded);
      const { bundles, anchors, placement } = await loadEngineSpecialBundlesForDate(
        date,
        unavailable
      );
      const pools = applyBundlesToAssignPools({
        available: availability.available.all,
        special: availability.special,
        extraSpecial: bundles.extraSpecial,
        skipFromAvailableIds: bundles.skipFromAvailableIds,
      });
      const fiftyFourHole =
        bundles.fiftyFourHole ??
        extractFiftyFourHoleCandidates(availability.special);
      const oneThreeCandidates =
        bundles.oneThreeCandidates ??
        extractOneThreeCandidates(availability.special);
      const oneTwoCandidates =
        bundles.oneTwoCandidates ??
        extractOneTwoCandidates(availability.special);
      const oneMakCandidates = bundles.oneMakCandidates ?? [];

      let openCourses: string[] | null = null;
      const openRaw = form.get("openCourses");
      if (typeof openRaw === "string" && openRaw.trim()) {
        try {
          const parsedOpen = JSON.parse(openRaw);
          if (Array.isArray(parsedOpen)) openCourses = parsedOpen.map(String);
        } catch {
          openCourses = openRaw.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }

      let houseStartCaddyId: number | null = null;
      const startRaw = form.get("houseStartCaddyId");
      if (startRaw != null && String(startRaw).trim() !== "") {
        const n = Number(startRaw);
        if (!Number.isInteger(n) || n < 1) {
          return NextResponse.json(
            {
              error: "오늘 1부 첫 캐디(id)가 올바르지 않습니다.",
              code: "house_start_caddy_invalid",
            },
            { status: 400 }
          );
        }
        houseStartCaddyId = n;
      }

      const thirdStartTeam = await resolvePreviewThirdStartTeam(
        date,
        form.get("thirdStartTeam")
      );
      const thirdStartCaddyId = parseOptionalThirdStartCaddyId(
        form.get("thirdStartCaddyId")
      );
      const caddyDirectory = availabilityRowsToCaddies([
        ...availability.available.all,
        ...availability.special,
        ...availability.excluded,
      ]);
      const specialSupportByShift = await loadSpecialSupportQueuesForDate(date);

      const result = computeAutoAssignmentsV1({
        date,
        reservations,
        available: pools.available,
        special: pools.special,
        fiftyFourHole,
        oneThreeCandidates,
        oneTwoCandidates,
        oneMakCandidates,
        placementMode: placement.mode,
        protectedTailCount: placement.protectedTailCount,
        oneThreeAnchor:
          placement.mode === "MANUAL" ? anchors.ONE_THREE : null,
        oneMakAnchor: placement.mode === "MANUAL" ? anchors.ONE_MAK : null,
        openCourses,
        houseStartCaddyId,
        thirdStartTeam,
        thirdStartCaddyId,
        caddyDirectory,
        specialSupportByShift,
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
        dailySummary: availability.dailySummary,
        specialDutySkipped: bundles.skippedPlacements,
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

    const reservations = stampReservationIdentities(
      (body.reservations || []) as AutoAssignReservation[]
    );
    let available = (body.available || []) as AutoAssignCaddy[];
    let special = (body.special || []) as AutoAssignCaddy[];
    let specialRows: AvailabilityRow[] = [];
    let specialDutySkipped: EngineSpecialBundles["skippedPlacements"] = [];
    let explicit54 = Array.isArray(body.fiftyFourHole)
      ? body.fiftyFourHole
      : null;
    let explicit13 = Array.isArray(body.oneThreeCandidates)
      ? body.oneThreeCandidates
      : null;
    let explicit12 = Array.isArray(body.oneTwoCandidates)
      ? body.oneTwoCandidates
      : null;
    let explicitMak = Array.isArray(body.oneMakCandidates)
      ? body.oneMakCandidates
      : null;
    let oneThreeAnchor = parseSpecialAnchor(body.oneThreeAnchor);
    let oneMakAnchor = parseSpecialAnchor(body.oneMakAnchor);
    let placementMode: "AUTO" | "MANUAL" | null = null;
    let protectedTailCount: number | undefined;
    let jsonCaddyDirectory: AutoAssignCaddy[] | undefined = Array.isArray(
      body.caddyDirectory
    )
      ? (body.caddyDirectory as AutoAssignCaddy[])
      : undefined;

    // available 생략 시 DB에서 로드 (읽기 전용)
    if (!Array.isArray(body.available)) {
      const availability = await loadAvailabilityForDate(date);
      available = availability.available.all;
      if (!Array.isArray(body.special)) {
        special = availability.special;
        specialRows = availability.special;
      }
      jsonCaddyDirectory = availabilityRowsToCaddies([
        ...availability.available.all,
        ...availability.special,
        ...availability.excluded,
      ]);
      const unavailable = unavailableReasonsFromRows(availability.excluded);
      const { bundles, anchors, placement } = await loadEngineSpecialBundlesForDate(
        date,
        unavailable
      );
      placementMode = placement.mode;
      protectedTailCount = placement.protectedTailCount;
      specialDutySkipped = bundles.skippedPlacements;
      const pools = applyBundlesToAssignPools({
        available,
        special,
        extraSpecial: bundles.extraSpecial,
        skipFromAvailableIds: bundles.skipFromAvailableIds,
      });
      available = pools.available;
      special = pools.special as AutoAssignCaddy[];
      if (explicit54 == null && bundles.fiftyFourHole !== null) {
        explicit54 = bundles.fiftyFourHole;
      }
      if (explicit13 == null && bundles.oneThreeCandidates !== null) {
        explicit13 = bundles.oneThreeCandidates;
      }
      if (explicit12 == null && bundles.oneTwoCandidates !== null) {
        explicit12 = bundles.oneTwoCandidates;
      }
      if (explicitMak == null && bundles.oneMakCandidates !== null) {
        explicitMak = bundles.oneMakCandidates;
      }
      if (placement.mode === "AUTO") {
        oneThreeAnchor = null;
        oneMakAnchor = null;
      } else {
        if (oneThreeAnchor == null) oneThreeAnchor = anchors.ONE_THREE;
        if (oneMakAnchor == null) oneMakAnchor = anchors.ONE_MAK;
      }
    } else {
      available = await regularPoolExcludingStoredOpsDuty(date, available);
      const placement = await resolveDailySpecialPlacement(date);
      placementMode = placement.mode;
      protectedTailCount = placement.protectedTailCount;
      if (placement.mode === "AUTO") {
        oneThreeAnchor = null;
        oneMakAnchor = null;
      }
    }

    const fiftyFourHole = extractFiftyFourHoleCandidates(
      specialRows,
      explicit54
    );
    const oneThreeCandidates = extractOneThreeCandidates(
      specialRows,
      explicit13
    );
    const oneTwoCandidates = extractOneTwoCandidates(
      specialRows,
      explicit12
    );
    const oneMakCandidates = Array.isArray(explicitMak) ? explicitMak : [];
    const fixedAssignments = Array.isArray(body.fixedAssignments)
      ? (body.fixedAssignments as FixedAssignmentInput[])
      : [];

    const openCourses = Array.isArray(body.openCourses)
      ? (body.openCourses as string[])
      : null;

    let houseStartCaddyId: number | null = null;
    if (
      body.houseStartCaddyId != null &&
      String(body.houseStartCaddyId).trim() !== ""
    ) {
      const n = Number(body.houseStartCaddyId);
      if (!Number.isInteger(n) || n < 1) {
        return NextResponse.json(
          {
            error: "오늘 1부 첫 캐디(id)가 올바르지 않습니다.",
            code: "house_start_caddy_invalid",
          },
          { status: 400 }
        );
      }
      houseStartCaddyId = n;
    }

    const result = computeAutoAssignmentsV1({
      date,
      reservations,
      available,
      special,
      fixedAssignments,
      fiftyFourHole,
      oneThreeCandidates,
      oneTwoCandidates,
      oneMakCandidates,
      placementMode,
      protectedTailCount,
      oneThreeAnchor: placementMode === "AUTO" ? null : oneThreeAnchor,
      oneMakAnchor: placementMode === "AUTO" ? null : oneMakAnchor,
      openCourses,
      houseStartCaddyId,
      thirdStartTeam: await resolvePreviewThirdStartTeam(
        date,
        body.thirdStartTeam
      ),
      thirdStartCaddyId: parseOptionalThirdStartCaddyId(body.thirdStartCaddyId),
      caddyDirectory: jsonCaddyDirectory,
      specialSupportByShift: await loadSpecialSupportQueuesForDate(date),
    });

    return NextResponse.json({
      mode: Array.isArray(body.available) ? "json" : "json+db-availability",
      specialDutySkipped,
      ...result,
    });
  } catch (e: unknown) {
    if (e instanceof HouseStartCaddyError || e instanceof ThirdStartCaddyError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    if (e instanceof OffSheetError || e instanceof DutyExcelError) {
      return NextResponse.json(
        { error: e.message, code: e.code },
        { status: e.status }
      );
    }
    const message = e instanceof Error ? e.message : "preview 실패";
    console.error("[POST /api/assignments/preview]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
