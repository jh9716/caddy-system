// src/utils/middleware.ts
import { NextRequest } from "next/server";

export function requireAdmin(req: NextRequest): { ok: boolean; admin: string } {
  const headerPass = req.headers.get("x-admin-password") || "";
  const headerAdmin = req.headers.get("x-admin-name") || "admin";
  const ok = headerPass && process.env.ADMIN_PASSWORD && headerPass === process.env.ADMIN_PASSWORD;
  return { ok: !!ok, admin: headerAdmin };
}
