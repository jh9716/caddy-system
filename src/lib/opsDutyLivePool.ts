import { listDailyOpsDutyCaddyIds } from "@/lib/dailyOpsDutyService";
import { excludeCaddiesById } from "@/lib/dailyOpsDuty";
import type { AutoAssignCaddy } from "@/lib/autoAssignEngine";

/** 라이브 reflow/apply 서버 경로: 저장된 당번·마샬·조장을 후보에서 강제 제외 */
export async function regularPoolExcludingStoredOpsDuty(
  date: string,
  pool: AutoAssignCaddy[]
): Promise<AutoAssignCaddy[]> {
  if (!date || !Array.isArray(pool)) return pool || [];
  const ids = await listDailyOpsDutyCaddyIds(date);
  return excludeCaddiesById(pool, ids);
}
