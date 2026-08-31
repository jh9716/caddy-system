import { listDailyOpsDutyCaddyIds } from "@/lib/dailyOpsDutyService";
import { excludeCaddiesById } from "@/lib/dailyOpsDuty";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";
import { loadCanonicalReflowState } from "@/lib/caddyPoolCanonicalService";

/** 라이브 reflow/apply 서버 경로: 저장된 당번·마샬·조장을 후보에서 강제 제외 */
export async function regularPoolExcludingStoredOpsDuty(
  date: string,
  pool: AutoAssignCaddy[]
): Promise<AutoAssignCaddy[]> {
  const resolved = await resolveCanonicalLivePool(date, pool);
  return resolved.computePool;
}

export async function resolveCanonicalLivePool(
  date: string,
  pool: AutoAssignCaddy[]
): Promise<{
  computePool: AutoAssignCaddy[];
  rosterBaseline: AutoAssignCaddy[];
  unavailableIds: number[];
}> {
  if (!date || !Array.isArray(pool)) {
    return { computePool: pool || [], rosterBaseline: pool || [], unavailableIds: [] };
  }
  try {
    const canonical = await loadCanonicalReflowState(date, pool);
    return {
      computePool: canonical.computePool,
      rosterBaseline: canonical.rosterBaseline,
      unavailableIds: canonical.unavailableIds,
    };
  } catch {
    const ids = await listDailyOpsDutyCaddyIds(date);
    return {
      computePool: excludeCaddiesById(pool, ids),
      rosterBaseline: pool,
      unavailableIds: [],
    };
  }
}
