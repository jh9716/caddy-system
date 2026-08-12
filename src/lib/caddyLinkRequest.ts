/**
 * CaddyLinkRequest domain — 직원 본인확인 제출 / 관리자 승인·반려
 *
 * - 제출 시 User.caddyId / Caddy.phoneNormalized 절대 변경 금지
 * - phone은 매칭 키가 아님 (이름 exact만)
 * - 승인 TX에서만 User.caddyId + Caddy.phoneNormalized + APPROVED
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizePersonName } from "@/lib/caddyImportRules";
import {
  CaddyPhoneError,
  isPhoneUniqueViolation,
  maskKrMobile,
  normalizeKrMobile,
} from "@/lib/caddyPhone";
import {
  isLinkableKakaoUser,
  type DbClient,
} from "@/lib/userCaddyLink";

export type { DbClient };

export class CaddyLinkRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CaddyLinkRequestError";
  }
}

export type StaffRequestView = {
  id: number;
  status: string;
  submittedName: string;
  maskedPhone: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  /** 직원에게 후보/조/id 비노출 */
};

export type AdminCandidateView = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

export type AdminRequestView = {
  id: number;
  status: string;
  submittedName: string;
  maskedPhone: string | null;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  selectedCaddyId: number | null;
  user: {
    id: number;
    username: string;
    kakaoUserId: string | null;
  };
  candidates: AdminCandidateView[];
};

function requireLinkableSubmitter(user: {
  id: number;
  kakaoUserId: string | null;
  role: string;
  caddyId: number | null;
}) {
  if (!isLinkableKakaoUser(user)) {
    throw new CaddyLinkRequestError(
      "not_linkable_user",
      "Kakao 캐디 계정만 본인확인 요청을 할 수 있습니다.",
      403
    );
  }
  if (user.caddyId != null) {
    throw new CaddyLinkRequestError(
      "already_linked",
      "이미 캐디에 연결된 계정입니다.",
      409,
      { caddyId: user.caddyId }
    );
  }
}

/** 동일 User의 PENDING 요청을 CANCELLED로 정리 (수동 link TX용) */
export async function cancelPendingLinkRequestsForUser(
  db: DbClient,
  userId: number,
  decisionNote = "superseded_by_manual_link"
): Promise<number> {
  const result = await db.caddyLinkRequest.updateMany({
    where: { userId, status: "PENDING" },
    data: {
      status: "CANCELLED",
      decidedAt: new Date(),
      decisionNote,
    },
  });
  return result.count;
}

export async function submitCaddyLinkRequest(
  db: PrismaClient,
  userId: number,
  input: { name: unknown; phone: unknown }
): Promise<StaffRequestView> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new CaddyLinkRequestError("invalid_user_id", "유효하지 않은 User id", 400);
  }

  const submittedNameRaw = String(input.name ?? "").trim();
  if (!submittedNameRaw) {
    throw new CaddyLinkRequestError("invalid_name", "이름을 입력해 주세요.", 400);
  }
  const matchKey = normalizePersonName(submittedNameRaw);
  if (!matchKey) {
    throw new CaddyLinkRequestError("invalid_name", "이름을 입력해 주세요.", 400);
  }

  let phoneNormalized: string;
  try {
    phoneNormalized = normalizeKrMobile(String(input.phone ?? ""));
  } catch (e) {
    if (e instanceof CaddyPhoneError) {
      throw new CaddyLinkRequestError("invalid_phone", e.message, e.status);
    }
    throw e;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, kakaoUserId: true, role: true, caddyId: true },
  });
  if (!user) {
    throw new CaddyLinkRequestError("not_found", "사용자를 찾을 수 없습니다.", 404);
  }
  requireLinkableSubmitter(user);

  const existingPending = await db.caddyLinkRequest.findFirst({
    where: { userId, status: "PENDING" },
    select: { id: true },
  });
  if (existingPending) {
    throw new CaddyLinkRequestError(
      "pending_exists",
      "이미 승인 대기 중인 요청이 있습니다. 취소 후 다시 신청해 주세요.",
      409,
      { requestId: existingPending.id }
    );
  }

  const active = await db.caddy.findMany({
    where: { employmentStatus: "ACTIVE" },
    select: { id: true, name: true },
  });
  const candidateCaddyIds = active
    .filter((c) => normalizePersonName(c.name) === matchKey)
    .map((c) => c.id)
    .sort((a, b) => a - b);

  if (candidateCaddyIds.length === 0) {
    throw new CaddyLinkRequestError(
      "no_candidates",
      "등록된 ACTIVE 캐디 이름과 일치하지 않습니다. 관리자에게 문의해 주세요.",
      404
    );
  }

  try {
    const created = await db.caddyLinkRequest.create({
      data: {
        userId,
        submittedName: submittedNameRaw,
        phoneNormalized,
        candidateCaddyIds,
        status: "PENDING",
      },
      select: {
        id: true,
        status: true,
        submittedName: true,
        phoneNormalized: true,
        requestedAt: true,
        decidedAt: true,
        decisionNote: true,
      },
    });
    return toStaffView(created);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new CaddyLinkRequestError(
        "pending_exists",
        "이미 승인 대기 중인 요청이 있습니다. 취소 후 다시 신청해 주세요.",
        409
      );
    }
    throw e;
  }
}

export async function getMineCaddyLinkRequest(
  db: DbClient,
  userId: number
): Promise<StaffRequestView | null> {
  const row = await db.caddyLinkRequest.findFirst({
    where: { userId },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      submittedName: true,
      phoneNormalized: true,
      requestedAt: true,
      decidedAt: true,
      decisionNote: true,
    },
  });
  return row ? toStaffView(row) : null;
}

export async function cancelCaddyLinkRequest(
  db: DbClient,
  userId: number,
  requestId: number
): Promise<StaffRequestView> {
  if (!Number.isFinite(requestId) || requestId <= 0) {
    throw new CaddyLinkRequestError("invalid_request_id", "유효하지 않은 요청 id", 400);
  }

  const row = await db.caddyLinkRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      userId: true,
      status: true,
      submittedName: true,
      phoneNormalized: true,
      requestedAt: true,
      decidedAt: true,
      decisionNote: true,
    },
  });
  if (!row) {
    throw new CaddyLinkRequestError("not_found", "요청을 찾을 수 없습니다.", 404);
  }
  if (row.userId !== userId) {
    throw new CaddyLinkRequestError("forbidden", "본인 요청만 취소할 수 있습니다.", 403);
  }
  if (row.status !== "PENDING") {
    throw new CaddyLinkRequestError(
      "not_pending",
      "대기 중인 요청만 취소할 수 있습니다.",
      409,
      { status: row.status }
    );
  }

  const updated = await db.caddyLinkRequest.updateMany({
    where: { id: requestId, userId, status: "PENDING" },
    data: {
      status: "CANCELLED",
      decidedAt: new Date(),
      decisionNote: "cancelled_by_user",
    },
  });
  if (updated.count !== 1) {
    throw new CaddyLinkRequestError(
      "not_pending",
      "대기 중인 요청만 취소할 수 있습니다.",
      409
    );
  }

  const after = await db.caddyLinkRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      submittedName: true,
      phoneNormalized: true,
      requestedAt: true,
      decidedAt: true,
      decisionNote: true,
    },
  });
  return toStaffView(after);
}

export async function listPendingCaddyLinkRequests(
  db: DbClient
): Promise<AdminRequestView[]> {
  const rows = await db.caddyLinkRequest.findMany({
    where: { status: "PENDING" },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      status: true,
      submittedName: true,
      phoneNormalized: true,
      candidateCaddyIds: true,
      selectedCaddyId: true,
      requestedAt: true,
      decidedAt: true,
      decisionNote: true,
      user: {
        select: {
          id: true,
          username: true,
          kakaoUserId: true,
        },
      },
    },
  });

  const allIds = [...new Set(rows.flatMap((r) => r.candidateCaddyIds))];
  const caddies =
    allIds.length === 0
      ? []
      : await db.caddy.findMany({
          where: { id: { in: allIds } },
          select: {
            id: true,
            name: true,
            team: true,
            teamOrder: true,
            employmentStatus: true,
          },
        });
  const byId = new Map(caddies.map((c) => [c.id, c]));

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    submittedName: r.submittedName,
    maskedPhone: maskKrMobile(r.phoneNormalized),
    requestedAt: r.requestedAt,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    selectedCaddyId: r.selectedCaddyId,
    user: {
      id: r.user.id,
      username: r.user.username,
      kakaoUserId: r.user.kakaoUserId,
    },
    candidates: r.candidateCaddyIds
      .map((id) => {
        const c = byId.get(id);
        if (!c) {
          return {
            id,
            name: "(삭제됨)",
            team: "",
            teamOrder: 0,
            employmentStatus: "UNKNOWN",
          };
        }
        return {
          id: c.id,
          name: c.name,
          team: c.team,
          teamOrder: c.teamOrder,
          employmentStatus: String(c.employmentStatus),
        };
      })
      .sort((a, b) => a.team.localeCompare(b.team, "ko") || a.teamOrder - b.teamOrder || a.id - b.id),
  }));
}

export async function approveCaddyLinkRequest(
  db: PrismaClient,
  requestId: number,
  selectedCaddyId: number,
  adminUserId: number | null
): Promise<{
  requestId: number;
  userId: number;
  caddyId: number;
  status: "APPROVED";
}> {
  if (!Number.isFinite(requestId) || requestId <= 0) {
    throw new CaddyLinkRequestError("invalid_request_id", "유효하지 않은 요청 id", 400);
  }
  if (!Number.isFinite(selectedCaddyId) || selectedCaddyId <= 0) {
    throw new CaddyLinkRequestError("invalid_caddy_id", "유효하지 않은 Caddy id", 400);
  }

  try {
    return await db.$transaction(async (tx) => {
      const req = await tx.caddyLinkRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          userId: true,
          status: true,
          phoneNormalized: true,
          candidateCaddyIds: true,
        },
      });
      if (!req) {
        throw new CaddyLinkRequestError("not_found", "요청을 찾을 수 없습니다.", 404);
      }
      if (req.status !== "PENDING") {
        throw new CaddyLinkRequestError(
          "not_pending",
          "대기 중인 요청만 승인할 수 있습니다.",
          409,
          { status: req.status }
        );
      }

      const user = await tx.user.findUnique({
        where: { id: req.userId },
        select: {
          id: true,
          kakaoUserId: true,
          role: true,
          caddyId: true,
        },
      });
      if (!user) {
        throw new CaddyLinkRequestError("not_found", "사용자를 찾을 수 없습니다.", 404);
      }
      requireLinkableSubmitter(user);

      if (!req.candidateCaddyIds.includes(selectedCaddyId)) {
        throw new CaddyLinkRequestError(
          "caddy_not_in_candidates",
          "선택한 캐디가 후보 목록에 없습니다.",
          400
        );
      }

      const caddy = await tx.caddy.findUnique({
        where: { id: selectedCaddyId },
        select: {
          id: true,
          employmentStatus: true,
          phoneNormalized: true,
        },
      });
      if (!caddy) {
        throw new CaddyLinkRequestError("caddy_not_found", "캐디를 찾을 수 없습니다.", 404);
      }
      if (String(caddy.employmentStatus) !== "ACTIVE") {
        throw new CaddyLinkRequestError(
          "caddy_not_active",
          "ACTIVE 캐디만 승인할 수 있습니다.",
          409,
          { employmentStatus: caddy.employmentStatus }
        );
      }

      const holder = await tx.user.findFirst({
        where: { caddyId: selectedCaddyId },
        select: { id: true },
      });
      if (holder) {
        throw new CaddyLinkRequestError(
          "caddy_already_linked",
          "이미 다른 계정에 연결된 캐디입니다.",
          409,
          { holderUserId: holder.id }
        );
      }

      const phoneHolder = await tx.caddy.findFirst({
        where: {
          phoneNormalized: req.phoneNormalized,
          NOT: { id: selectedCaddyId },
        },
        select: { id: true },
      });
      if (phoneHolder) {
        throw new CaddyLinkRequestError(
          "phone_duplicate",
          "이미 다른 캐디에 등록된 휴대폰번호입니다.",
          409,
          { otherCaddyId: phoneHolder.id }
        );
      }

      if (
        caddy.phoneNormalized != null &&
        caddy.phoneNormalized !== "" &&
        caddy.phoneNormalized !== req.phoneNormalized
      ) {
        throw new CaddyLinkRequestError(
          "phone_conflict",
          "선택한 캐디에 다른 휴대폰번호가 이미 등록되어 있습니다.",
          409,
          { currentMasked: maskKrMobile(caddy.phoneNormalized) }
        );
      }

      const linked = await tx.user.updateMany({
        where: {
          id: user.id,
          caddyId: null,
          kakaoUserId: { not: null },
        },
        data: { caddyId: selectedCaddyId },
      });
      if (linked.count !== 1) {
        throw new CaddyLinkRequestError(
          "already_linked",
          "이미 연결된 계정이거나 연결할 수 없는 상태입니다.",
          409
        );
      }

      // 같은 번호면 유지, null이면 설정. 다른 번호는 위에서 차단됨.
      if (caddy.phoneNormalized !== req.phoneNormalized) {
        await tx.caddy.update({
          where: { id: selectedCaddyId },
          data: { phoneNormalized: req.phoneNormalized },
        });
      }

      const approved = await tx.caddyLinkRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: {
          status: "APPROVED",
          selectedCaddyId,
          decidedAt: new Date(),
          decidedByUserId: adminUserId,
        },
      });
      if (approved.count !== 1) {
        throw new CaddyLinkRequestError(
          "not_pending",
          "대기 중인 요청만 승인할 수 있습니다.",
          409
        );
      }

      return {
        requestId,
        userId: user.id,
        caddyId: selectedCaddyId,
        status: "APPROVED" as const,
      };
    });
  } catch (e) {
    if (e instanceof CaddyLinkRequestError) throw e;
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      if (isPhoneUniqueViolation(e)) {
        throw new CaddyLinkRequestError(
          "phone_duplicate",
          "이미 다른 캐디에 등록된 휴대폰번호입니다.",
          409
        );
      }
      throw new CaddyLinkRequestError(
        "caddy_already_linked",
        "이미 다른 계정에 연결된 캐디입니다.",
        409
      );
    }
    throw e;
  }
}

export async function rejectCaddyLinkRequest(
  db: DbClient,
  requestId: number,
  adminUserId: number | null,
  decisionNote?: string | null
): Promise<{ requestId: number; status: "REJECTED" }> {
  if (!Number.isFinite(requestId) || requestId <= 0) {
    throw new CaddyLinkRequestError("invalid_request_id", "유효하지 않은 요청 id", 400);
  }

  const note =
    decisionNote == null || String(decisionNote).trim() === ""
      ? null
      : String(decisionNote).trim().slice(0, 500);

  const updated = await db.caddyLinkRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: {
      status: "REJECTED",
      decidedAt: new Date(),
      decidedByUserId: adminUserId,
      decisionNote: note,
    },
  });
  if (updated.count !== 1) {
    const row = await db.caddyLinkRequest.findUnique({
      where: { id: requestId },
      select: { id: true, status: true },
    });
    if (!row) {
      throw new CaddyLinkRequestError("not_found", "요청을 찾을 수 없습니다.", 404);
    }
    throw new CaddyLinkRequestError(
      "not_pending",
      "대기 중인 요청만 반려할 수 있습니다.",
      409,
      { status: row.status }
    );
  }
  return { requestId, status: "REJECTED" };
}

function toStaffView(row: {
  id: number;
  status: string;
  submittedName: string;
  phoneNormalized: string;
  requestedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}): StaffRequestView {
  return {
    id: row.id,
    status: row.status,
    submittedName: row.submittedName,
    maskedPhone: maskKrMobile(row.phoneNormalized),
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
  };
}

/** cookie session → DB User (직원 API용) */
export async function resolveSessionUser(
  db: DbClient,
  username: string | null
): Promise<{
  id: number;
  username: string;
  role: string;
  kakaoUserId: string | null;
  caddyId: number | null;
} | null> {
  if (!username) return null;
  return db.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      role: true,
      kakaoUserId: true,
      caddyId: true,
    },
  });
}
