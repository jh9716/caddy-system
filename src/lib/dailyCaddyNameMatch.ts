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

/** 한 칸에 여러 이름이 있으면 분리 (쉼표/슬래시/공백/줄바꿈/가운뎃점/한글.한글). 글자 수 절단 없음. */
export function splitPersonNames(raw: unknown): string[] {
  const text = String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .trim();
  if (!text) return [];
  const delimited = text.replace(/(?<=[가-힣])\s*\.\s*(?=[가-힣])/g, ",");
  const parts = delimited
    .split(/[,，/／·•、\s]+/)
    .map((p) => normalizePersonName(p))
    .filter(Boolean);
  return [...new Set(parts)];
}

export type NameSegmentationKind = "exact" | "unique-split" | "ambiguous" | "none";

export type NameSegmentationResult = {
  kind: NameSegmentationKind;
  names: string[];
};

/**
 * 알려진 재직 이름만으로 token을 유일하게 2명 이상 분해할 수 있으면 그 분해를 반환.
 * exact 전체 일치·애매·불가능은 임의 선택하지 않는다.
 */
export function uniqueNameSegmentation(
  token: string,
  knownNames: readonly string[]
): NameSegmentationResult {
  const normalized = normalizePersonName(token);
  if (!normalized) return { kind: "none", names: [] };
  const names = [
    ...new Set(
      knownNames.map((n) => normalizePersonName(n)).filter((n) => n.length > 0)
    ),
  ];
  if (names.includes(normalized)) {
    return { kind: "exact", names: [normalized] };
  }

  const n = normalized.length;
  const ways = Array(n + 1).fill(0);
  const ambiguous = Array(n + 1).fill(false);
  const prev: Array<{ at: number; name: string } | null> = Array(n + 1).fill(
    null
  );
  ways[0] = 1;
  for (let i = 0; i <= n; i++) {
    if (ways[i] === 0) continue;
    for (const name of names) {
      const j = i + name.length;
      if (j > n) continue;
      if (normalized.slice(i, j) !== name) continue;
      if (ways[j] > 0 || ambiguous[j]) ambiguous[j] = true;
      else prev[j] = { at: i, name };
      ways[j] += ways[i];
      if (ambiguous[i]) ambiguous[j] = true;
    }
  }
  if (ways[n] === 0) return { kind: "none", names: [normalized] };
  if (ambiguous[n] || ways[n] !== 1) {
    return { kind: "ambiguous", names: [normalized] };
  }
  const parts: string[] = [];
  let i = n;
  while (i > 0) {
    const step = prev[i];
    if (!step) return { kind: "none", names: [normalized] };
    parts.push(step.name);
    i = step.at;
  }
  parts.reverse();
  if (parts.length < 2) return { kind: "none", names: [normalized] };
  return { kind: "unique-split", names: parts };
}

/**
 * 휴무 이름 매칭 전 안전 분할.
 * 전체 exact match면 1명. 아니면 ACTIVE 이름만으로 유일한 2+ 분해일 때만 분리.
 * RETIRED/LEAVE 이름은 segmentation에 쓰지 않는다.
 */
export function resolveOffSheetNameTokens(
  rawName: string,
  caddies: readonly NameMatchCaddy[]
): string[] {
  const token = normalizePersonName(rawName);
  if (!token) return [];
  const exact = matchCaddyByExactName(token, caddies);
  if (exact.status === "matched" || exact.status === "inactive") {
    return [token];
  }
  if (exact.status === "review" && exact.reason.includes("임의 매칭 금지")) {
    return [token];
  }
  const activeNames = caddies
    .filter((c) => employmentOf(c) === "ACTIVE")
    .map((c) => c.name);
  const segmented = uniqueNameSegmentation(token, activeNames);
  if (segmented.kind === "unique-split") return segmented.names;
  return [token];
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
