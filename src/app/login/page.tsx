import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const store = await cookies();
  const role = store.get("role")?.value ?? null;

  if (role === "admin") redirect("/manage");
  if (role === "caddy") redirect("/caddy");

  return <LoginClient />;
}
