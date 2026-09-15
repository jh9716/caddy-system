/**
 * 당번·마샬·조장 roleKey 상수.
 * Excel / Node 의존 없음. client bundle에 parser를 끌어들이지 않는다.
 */

export type DutyRoleKind =
  | "duty_am"
  | "duty_pm"
  | "marshal_am"
  | "marshal_pm"
  | "leader";

export const DUTY_ROLE_LABELS: Record<DutyRoleKind, string> = {
  duty_am: "조출당번",
  duty_pm: "후출당번",
  marshal_am: "조출마샬",
  marshal_pm: "후출마샬",
  leader: "조장",
};

export const DUTY_ROLE_KEY_KIND: Record<string, DutyRoleKind> = {
  당번_조출_1: "duty_am",
  당번_조출_2: "duty_am",
  당번_후출_1: "duty_pm",
  당번_후출_2: "duty_pm",
  마샬_조출_1: "marshal_am",
  마샬_조출_2: "marshal_am",
  마샬_후출_1: "marshal_pm",
  조장_1: "leader",
};

export const OPS_DUTY_ROLE_KEYS = [
  "당번_조출_1",
  "당번_조출_2",
  "당번_후출_1",
  "당번_후출_2",
  "마샬_조출_1",
  "마샬_조출_2",
  "마샬_후출_1",
  "조장_1",
] as const;

export type OpsDutyRoleKey = (typeof OPS_DUTY_ROLE_KEYS)[number];

export type DutyExcelEntry = {
  kind: DutyRoleKind;
  roleKey: string;
  rawName: string;
};

export function isOpsDutyRoleKey(value: unknown): value is OpsDutyRoleKey {
  return OPS_DUTY_ROLE_KEYS.includes(String(value) as OpsDutyRoleKey);
}
