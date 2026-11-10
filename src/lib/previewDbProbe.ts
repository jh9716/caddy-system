/**
 * TEMPORARY Preview-only diagnostic. Remove after PR #368 Preview DB
 * connection is verified:
 *   - this file
 *   - src/app/api/diag/preview-db-probe/route.ts
 *   - scripts/test-preview-db-probe-unit.ts
 *
 * Never logs DATABASE_URL, passwords, or neon hostnames.
 */

export const PREVIEW_DB_PROBE_BRANCH = "preview-db-comment-replies-8d28";
export const PREVIEW_DB_PROBE_ENDPOINT_ID = "ep-odd-voice-aokrqp5t";
export const PREVIEW_DB_PROBE_DATABASE = "neondb";

export type PreviewDbProbeDenyReason =
  | "production"
  | "not_preview"
  | "branch_mismatch"
  | "not_vercel";

export type PreviewDbProbeGate = {
  allowQuery: boolean;
  denyReason: PreviewDbProbeDenyReason | null;
};

export function evaluatePreviewDbProbeGate(
  env: Record<string, string | undefined>
): PreviewDbProbeGate {
  const vercelEnv = String(env.VERCEL_ENV || "").trim();
  if (vercelEnv === "production") {
    return { allowQuery: false, denyReason: "production" };
  }
  if (String(env.VERCEL || "").trim() !== "1") {
    return { allowQuery: false, denyReason: "not_vercel" };
  }
  if (vercelEnv !== "preview") {
    return { allowQuery: false, denyReason: "not_preview" };
  }
  const ref = String(env.VERCEL_GIT_COMMIT_REF || "").trim();
  if (ref !== PREVIEW_DB_PROBE_BRANCH) {
    return { allowQuery: false, denyReason: "branch_mismatch" };
  }
  return { allowQuery: true, denyReason: null };
}

export function classifyPreviewDbIdentity(input: {
  neonEndpoint: string | null | undefined;
  database: string | null | undefined;
}): { endpointMatch: boolean; databaseMatch: boolean; match: boolean } {
  const endpointMatch = String(input.neonEndpoint || "") === PREVIEW_DB_PROBE_ENDPOINT_ID;
  const databaseMatch = String(input.database || "") === PREVIEW_DB_PROBE_DATABASE;
  return {
    endpointMatch,
    databaseMatch,
    match: endpointMatch && databaseMatch,
  };
}
