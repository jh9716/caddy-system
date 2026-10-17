/**
 * HOUSE/THIRD 고정 슬롯 쓰기 잠금.
 *
 * Caddy(team, teamOrder) 에 unique 가 없고, SELECT FOR UPDATE 는 기존 행만 잠근다.
 * 같은 조 INSERT 는 행 잠금으로 막히지 않는다.
 *
 * SHARE ROW EXCLUSIVE 는 INSERT/UPDATE/DELETE 가 잡는 ROW EXCLUSIVE 와 충돌한다.
 * 슬롯을 바꾸는 POST/PATCH/재배치가 모두 이 잠금을 잡은 뒤 occupancy 를 다시 읽어야
 * 신규 등록과 단건 수정까지 상호 보호된다. advisory lock 만으로는 POST/PATCH 가
 * 같은 키를 잡지 않으면 INSERT 를 막지 못한다.
 *
 * ACCESS SHARE(일반 SELECT) 와는 공존하므로 Preview/목록 조회는 막지 않는다.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

export const CADDY_SLOT_TABLE_LOCK_MODE = "SHARE ROW EXCLUSIVE";

export const CADDY_SLOT_LOCK_TX_TIMEOUT_MS = 20_000;
export const CADDY_SLOT_LOCK_TX_MAX_WAIT_MS = 10_000;

export const CADDY_SLOT_LOCK_TX_OPTIONS = {
  maxWait: CADDY_SLOT_LOCK_TX_MAX_WAIT_MS,
  timeout: CADDY_SLOT_LOCK_TX_TIMEOUT_MS,
};

export function buildCaddySlotTableLockSql(): Prisma.Sql {
  return Prisma.sql`LOCK TABLE "Caddy" IN SHARE ROW EXCLUSIVE MODE`;
}

export function isCaddySlotTableLockQuery(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  const sql = query as {
    strings?: readonly string[];
    text?: string;
  };
  const text = Array.isArray(sql.strings)
    ? sql.strings.join("")
    : typeof sql.text === "string"
      ? sql.text
      : "";
  return /LOCK\s+TABLE\s+"Caddy"\s+IN\s+SHARE\s+ROW\s+EXCLUSIVE\s+MODE/i.test(
    text
  );
}

export async function lockCaddyTableForSlotMutation(tx: {
  $executeRaw: (query: Prisma.Sql) => Promise<unknown>;
}): Promise<void> {
  await tx.$executeRaw(buildCaddySlotTableLockSql());
}

export async function withCaddySlotMutation<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockCaddyTableForSlotMutation(tx);
    return fn(tx);
  }, CADDY_SLOT_LOCK_TX_OPTIONS);
}
