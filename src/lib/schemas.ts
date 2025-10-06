// src/lib/schemas.ts
import { z } from 'zod';

// Prisma enum(CaddyStatus) 값과 반드시 일치해야 합니다.
export const CaddyStatusEnum = z.enum([
  '근무중',
  '휴무',
  '병가',
  '장기병가',
  '당번',
  '마샬',
  '1부',
  '3부',
  '54홀',
]);

// 생성 시
export const CaddyCreateSchema = z.object({
  name: z.string().min(1, '이름은 필수입니다.').trim(),
  team: z.string().trim().optional().default(''),
  status: CaddyStatusEnum.optional().default('근무중'),
});

// 부분 수정 시(모든 필드 선택적)
export const CaddyUpdateSchema = z.object({
  name: z.string().min(1).trim().optional(),
  team: z.string().trim().optional(),
  status: CaddyStatusEnum.optional(),
});

// 목록 조회 쿼리
export const CaddyListQuerySchema = z.object({
  search: z.string().trim().optional().default(''),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
