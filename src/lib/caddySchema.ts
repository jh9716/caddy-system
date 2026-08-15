import { z } from "zod";
import {
  EMPLOYMENT_STATUSES,
  EXTRA_FLAG_OPTIONS,
  TEAM_OPTIONS,
  normalizeEmploymentStatus,
} from "@/lib/caddyManage";

export const caddyStatus = z.enum(["근무중", "휴무", "병가"]);

export const employmentStatusSchema = z
  .string()
  .transform((v) => normalizeEmploymentStatus(v))
  .pipe(z.enum(EMPLOYMENT_STATUSES));

export const extraFlagSchema = z.enum(EXTRA_FLAG_OPTIONS);

/** UI/API 입력 필드명. DB 컬럼은 phoneNormalized. 빈 문자열 허용(서버에서 null). */
const phoneInputSchema = z.string().optional().nullable();

export const caddyCreateSchema = z.object({
  name: z.string().trim().min(1, "이름은 필수입니다."),
  team: z.string().trim().min(1, "조는 필수입니다."),
  /** 고정 슬롯 번호 — 필수, 1 이상. max+1 자동부여 없음. */
  teamOrder: z.coerce
    .number({ message: "빈 슬롯(teamOrder)을 선택해주세요." })
    .int()
    .min(1, "슬롯(teamOrder)은 1 이상이어야 합니다."),
  employmentStatus: employmentStatusSchema.optional().default("ACTIVE"),
  extraFlags: z.array(extraFlagSchema).optional().default([]),
  status: caddyStatus.optional().default("근무중"),
  memo: z.string().optional().nullable(),
  phone: phoneInputSchema,
  // optional passthrough fields — never wipe Production defaults if omitted
  employeeCode: z.string().trim().min(1).optional().nullable(),
  caddyType: z.enum(["HOUSE", "THIRD", "DRIVING"]).optional(),
  missingFromImport: z.boolean().optional(),
});

export const caddyUpdateSchema = z.object({
  name: z.string().trim().min(1, "이름은 필수입니다.").optional(),
  team: z.string().trim().min(1, "조는 필수입니다.").optional(),
  teamOrder: z.coerce.number().int().min(1, "슬롯(teamOrder)은 1 이상이어야 합니다.").optional(),
  employmentStatus: employmentStatusSchema.optional(),
  extraFlags: z.array(extraFlagSchema).optional(),
  status: caddyStatus.optional(),
  memo: z.string().optional().nullable(),
  /** 생략 시 기존 phone 유지. null/"" → 삭제(null). */
  phone: phoneInputSchema,
  employeeCode: z.string().trim().min(1).optional().nullable(),
  caddyType: z.enum(["HOUSE", "THIRD", "DRIVING"]).optional(),
  missingFromImport: z.boolean().optional(),
  /**
   * ↑↓ 스왑: 대상 캐디 id. 서버가 두 슬롯을 원자적으로 교환.
   * 조 이동(고정 슬롯)과 별개.
   */
  swapWithId: z.coerce.number().int().positive().optional(),
});

export type CaddyCreateInput = z.infer<typeof caddyCreateSchema>;
export type CaddyUpdateInput = z.infer<typeof caddyUpdateSchema>;

export const TEAM_SELECT_OPTIONS = TEAM_OPTIONS;
