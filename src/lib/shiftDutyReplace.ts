/** Atomic replace of one (date, part) ShiftDuty set. */

export const SHIFT_DUTY_REPLACE_EMPTY_MESSAGE = "할당 가능한 인원이 없습니다.";

export class ShiftDutyReplaceEmptyError extends Error {
  readonly code = "EMPTY_SHIFT_DUTY";
  constructor() {
    super(SHIFT_DUTY_REPLACE_EMPTY_MESSAGE);
    this.name = "ShiftDutyReplaceEmptyError";
  }
}

export function isShiftDutyReplaceEmptyError(
  e: unknown
): e is ShiftDutyReplaceEmptyError {
  return e instanceof ShiftDutyReplaceEmptyError;
}

export type ShiftDutyReplaceRow = {
  date: Date;
  part: string;
  variant: string;
  orderNo: number;
  caddyId: number;
  team?: string | null;
};

export type ShiftDutyReplaceTx = {
  shiftDuty: {
    deleteMany: (args: {
      where: { date: Date; part: string };
    }) => Promise<unknown>;
    createMany: (args: { data: ShiftDutyReplaceRow[] }) => Promise<unknown>;
  };
};

export async function replaceShiftDuties(
  tx: ShiftDutyReplaceTx,
  input: { date: Date; part: string; rows: ShiftDutyReplaceRow[] }
): Promise<number> {
  await tx.shiftDuty.deleteMany({
    where: { date: input.date, part: input.part },
  });
  if (input.rows.length === 0) {
    throw new ShiftDutyReplaceEmptyError();
  }
  await tx.shiftDuty.createMany({ data: input.rows });
  return input.rows.length;
}
