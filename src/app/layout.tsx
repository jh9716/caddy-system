import "./globals.css";
import Link from "next/link";
import { cookies } from "next/headers";
import LogoutButton from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const role = store.get("role")?.value ?? null;

  return (
    <html lang="ko">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <header className="border-b bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href="/" className="font-semibold">VERTHILL • Caddy</Link>

            <nav className="flex items-center gap-3 text-sm">
              <Link className="rounded-md border px-3 py-1.5 hover:bg-slate-50" href="/">홈</Link>
              <Link className="rounded-md border px-3 py-1.5 hover:bg-slate-50" href="/notice">공지</Link>

              {role === "admin" && (
                <Link className="rounded-md border px-3 py-1.5 hover:bg-slate-50" href="/manage">
                  관리자
                </Link>
              )}
              {role === "caddy" && (
                <Link className="rounded-md border px-3 py-1.5 hover:bg-slate-50" href="/caddy">
                  내 대시보드
                </Link>
              )}

              {role ? (
                <LogoutButton />
              ) : (
                <Link className="rounded-md border px-3 py-1.5 hover:bg-slate-50" href="/login">
                  로그인
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
