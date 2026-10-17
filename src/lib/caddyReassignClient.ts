/**
 * 캐디 일괄 재배치 Preview/Apply HTTP 클라이언트.
 * 적용은 서버 Preview 가 준 base 를 그대로 보내며, 자동 재시도하지 않는다.
 */
import type {
  ReassignBaseRow,
  ReassignChange,
  ReassignIssue,
  ReassignMode,
  ReassignPlacement,
} from "@/lib/caddyReassign";

export const CADDY_REASSIGN_PREVIEW_PATH = "/api/caddies/reassign/preview";
export const CADDY_REASSIGN_APPLY_PATH = "/api/caddies/reassign/apply";

export type ReassignPreviewOk = {
  ok: true;
  mode: ReassignMode;
  requestedIds: number[];
  affectedIds: number[];
  affectedTeams: string[];
  changes: ReassignChange[];
  issues: ReassignIssue[];
  existingAnomalies: ReassignIssue[];
  base: ReassignBaseRow[];
};

export type ReassignApplyOk = {
  ok: true;
  updated: number;
  requestedIds: number[];
  affectedIds: number[];
  affectedTeams: string[];
  changes: ReassignChange[];
  auditId: number;
};

export type ReassignClientError = {
  ok: false;
  status: number;
  error: string;
  code?: string;
  issues?: ReassignIssue[];
};

export type ReassignClientResult<T> = T | ReassignClientError;

export type CaddyReassignFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

type ClientOptions = {
  fetch?: CaddyReassignFetch;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function asError(
  status: number,
  data: Record<string, unknown>,
  fallback: string
): ReassignClientError {
  const issues = Array.isArray(data.issues)
    ? (data.issues as ReassignIssue[])
    : undefined;
  return {
    ok: false,
    status,
    error: String(data.error ?? issues?.[0]?.message ?? fallback),
    code: typeof data.code === "string" ? data.code : issues?.[0]?.code,
    issues,
  };
}

export async function postCaddyReassignPreview(
  body: { placements: ReassignPlacement[]; mode?: ReassignMode },
  options?: ClientOptions
): Promise<ReassignClientResult<ReassignPreviewOk>> {
  const fetchFn = options?.fetch ?? fetch;
  const res = await fetchFn(CADDY_REASSIGN_PREVIEW_PATH, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      placements: body.placements,
      mode: body.mode ?? "explicit",
    }),
  });
  const data = await readJson(res);
  if (!res.ok || data.ok === false) {
    return asError(res.status, data, "배치 미리보기를 만들지 못했습니다.");
  }
  return data as ReassignPreviewOk;
}

export async function postCaddyReassignApply(
  body: {
    placements: ReassignPlacement[];
    mode?: ReassignMode;
    base: ReassignBaseRow[];
  },
  options?: ClientOptions
): Promise<ReassignClientResult<ReassignApplyOk>> {
  const fetchFn = options?.fetch ?? fetch;
  const res = await fetchFn(CADDY_REASSIGN_APPLY_PATH, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      placements: body.placements,
      mode: body.mode ?? "explicit",
      base: body.base,
    }),
  });
  const data = await readJson(res);
  if (!res.ok || data.ok === false) {
    return asError(res.status, data, "배치를 저장하지 못했습니다.");
  }
  return data as ReassignApplyOk;
}

export function isStaleRosterError(
  result: ReassignClientError | { ok: true }
): boolean {
  return result.ok === false && result.code === "stale_roster";
}
