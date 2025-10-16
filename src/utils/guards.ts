// src/utils/guards.ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { redirect, notFound } from "next/navigation";

export async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  return session;
}

export async function requireAdmin() {
  const session = await requireUser();
  if ((session.user as any).role !== "admin") notFound();
  return session;
}

export async function requireCaddy() {
  const session = await requireUser();
  if ((session.user as any).role !== "caddy") notFound();
  return session;
}
