// src/lib/caddySchema.ts
import { z } from "zod";

export const caddyStatus = z.enum(["근무중", "휴무", "병가"]);

export const caddyCreateSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다."),
  team: z.string().min(1, "조는 필수입니다."),
  status: caddyStatus.default("근무중"),
});

export const caddyUpdateSchema = z.object({
  name: z.string().min(1, "이름은 필수입니다.").optional(),
  team: z.string().min(1, "조는 필수입니다.").optional(),
  status: caddyStatus.optional(),
});

export type CaddyCreateInput = z.infer<typeof caddyCreateSchema>;
export type CaddyUpdateInput = z.infer<typeof caddyUpdateSchema>;
