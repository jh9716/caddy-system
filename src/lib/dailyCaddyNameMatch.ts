/**
 * 당일 가용 제외용 이름 매칭 (순수 함수, DB write 없음)
 * - trim + 공백 제거 후 Caddy 이름 정확 일치
 * - ACTIVE 1명만 제외 대상. 2명 이상이면 임의 매칭 금지
 */

export type MatchEmployment = "ACTIVE" | "LEAVE" | "RETIRED" | string;

export type NameMatchCaddy = {
  id: number;
  name: string;
  employmentStatus: MatchEmployment;
};

export type NameMatchOk = {
  status: "matched";
  caddyId: number;
  name: string;
};

export type NameMatchInactive = {
  status: "inactive";
  name: string;
  reason: string;
};

export type NameMatchReview = {
  status: "review";
  name: string;
  reason: string;
};

export type NameMatchResult = NameMatchOk | NameMatchInactive | NameMatchReview;

/** 표시·매칭용: 앞뒤 공백 제거, 내부 공백 제거, 괄호 주석 제거 */
export function normalizePersonName(raw: unknown): string {
  let text = String(raw ?? "").replace(/\u00a0/g, " ").trim();
  if (!text) return "";
  text = text.replace(/[（(][^）)]*[）)]/g, " ");
  text = text.replace(/예비군/g, " ");
  text = text.replace(/\s+/g, "");
  return text;
}

/** 한 칸에 여러 이름이 있으면 분리 (쉼표/슬래시/가운뎃점/한글.한글) */
export function splitPersonNames(raw: unknown): string[] {
  const text = String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .trim();
  if (!text) return [];
  const parts = text
    .split(/[,，/／·•、]|(?<=[가-힣])\s*\.\s*(?=[가-힣])/)
    .map((p) => normalizePersonName(p))
    .filter(Boolean);
  return [...new Set(parts)];
}

function employmentOf(c: NameMatchCaddy): string {
  return String(c.employmentStatus ?? "").trim().toUpperCase();
}

export function matchCaddyByExactName(
  rawName: string,
  caddies: readonly NameMatchCaddy[]
): NameMatchResult {
  const name = normalizePersonName(rawName);
  if (!name) {
    return { status: "review", name: String(rawName ?? "").trim(), reason: "이름이 비어 있음" };
  }

  const hits = caddies.filter((c) => normalizePersonName(c.name) === name);
  if (hits.length === 0) {
    return { status: "review", name, reason: "일치하는 캐디 없음" };
  }

  const active = hits.filter((c) => employmentOf(c) === "ACTIVE");
  if (active.length === 1) {
    return { status: "matched", caddyId: active[0].id, name: active[0].name };
  }
  if (active.length >= 2) {
    return {
      status: "review",
      name,
      reason: `동일 이름 ACTIVE ${active.length}명 — 임의 매칭 금지`,
    };
  }

  const emp = employmentOf(hits[0]);
  const label =
    emp === "RETIRED" ? "퇴사(RETIRED)" : emp === "LEAVE" ? "휴직(LEAVE)" : `비가용(${emp || "UNKNOWN"})`;
  return {
    status: "inactive",
    name: hits[0].name,
    reason: `${label} — 이미 가용대상이 아님`,
  };
}
