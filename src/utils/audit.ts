// src/utils/audit.ts
import { prisma } from "@/prisma";

export async function logAudit(admin: string, action: string) {
  try {
    await prisma.auditLog.create({
      data: {
        admin,
        action,
      },
    });
  } catch (e) {
    // 로깅 실패는 서비스 흐름 막지 않음
    console.error("[AuditLog]", e);
  }
}
