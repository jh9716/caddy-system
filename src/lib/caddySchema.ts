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

export const caddyCreateSchema = z.object({
  name: z.string().trim().min(1, "이름은 필수입니다."),
  team: z.string().trim().min(1, "조는 필수입니다."),
  teamOrder: z.coerce.number().int().min(0).optional().default(0),
  employmentStatus: employmentStatusSchema.optional().default("ACTIVE"),
  extraFlags: z.array(extraFlagSchema).optional().default([]),
  status: caddyStatus.optional().default("근무중"),
  memo: z.string().optional().nullable(),
  // optional passthrough fields — never wipe Production defaults if omitted
  employeeCode: z.string().trim().min(1).optional().nullable(),
  caddyType: z.enum(["HOUSE", "THIRD", "DRIVING"]).optional(),
  missingFromImport: z.boolean().optional(),
});

export const caddyUpdateSchema = z.object({
  name: z.string().trim().min(1, "이름은 필수입니다.").optional(),
  team: z.string().trim().min(1, "조는 필수입니다.").optional(),
  teamOrder: z.coerce.number().int().min(0).optional(),
  employmentStatus: employmentStatusSchema.optional(),
  extraFlags: z.array(extraFlagSchema).optional(),
  status: caddyStatus.optional(),
  memo: z.string().optional().nullable(),
  employeeCode: z.string().trim().min(1).optional().nullable(),
  caddyType: z.enum(["HOUSE", "THIRD", "DRIVING"]).optional(),
  missingFromImport: z.boolean().optional(),
});

export type CaddyCreateInput = z.infer<typeof caddyCreateSchema>;
export type CaddyUpdateInput = z.infer<typeof caddyUpdateSchema>;

export const TEAM_SELECT_OPTIONS = TEAM_OPTIONS;
