import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { resolveAuthFromCookieStore } from "@/lib/auth";

export async function requireUser() {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth) redirect("/login");
  return auth;
}

export async function requireAdmin() {
  const auth = await requireUser();
  if (auth.role !== "admin") notFound();
  if (auth.mustChangePassword) redirect("/change-password");
  return auth;
}

export async function requireCaddy() {
  const auth = await requireUser();
  if (auth.role !== "caddy" && auth.role !== "leader") notFound();
  return auth;
}
