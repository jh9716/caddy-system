import { listDailyOpsDutyCaddyIds } from "@/lib/dailyOpsDutyService";
import { excludeCaddiesById } from "@/lib/dailyOpsDuty";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";
import {
  loadCanonicalReflowState,
  type CanonicalReflowState,
  type LoadCanonicalReflowOptions,
} from "@/lib/caddyPoolCanonicalService";

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
  pool: AutoAssignCaddy[],
  opts?: LoadCanonicalReflowOptions & {
    rosterClientPool?: readonly AutoAssignCaddy[] | null;
    db?: unknown;
  }
): Promise<
  CanonicalReflowState & {
    computePool: AutoAssignCaddy[];
    rosterBaseline: AutoAssignCaddy[];
    unavailableIds: number[];
  }
> {
  const empty: CanonicalReflowState = {
    computePool: pool || [],
    rosterBaseline: pool || [],
    unavailableIds: [],
    opsDutyIds: [],
    specialSkipIds: [],
    offSheetMatched: false,
    offSheetSource: "skipped",
  };
  if (!date || !Array.isArray(pool)) {
    return empty;
  }
  try {
    return await loadCanonicalReflowState(
      date,
      opts?.rosterClientPool ?? pool,
      opts?.db,
      {
        offSheetMode: opts?.offSheetMode,
        computeClientPool: opts?.computeClientPool ?? pool,
      }
    );
  } catch {
    const ids = await listDailyOpsDutyCaddyIds(date);
    return {
      ...empty,
      computePool: excludeCaddiesById(pool, ids),
      rosterBaseline: [...(opts?.rosterClientPool || pool)],
    };
  }
}
