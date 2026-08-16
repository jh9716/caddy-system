import "./globals.css";
import Link from "next/link";
import { cookies } from "next/headers";
import { Cormorant_Garamond, Noto_Serif_KR, Source_Sans_3 } from "next/font/google";
import LogoutButton from "@/components/LogoutButton";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-loaded",
  display: "swap",
});

const displayKr = Noto_Serif_KR({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-kr-loaded",
  display: "swap",
});

const sans = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans-loaded",
  display: "swap",
});

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const role = (await getVerifiedSessionFromCookies(store))?.role ?? null;

  return (
    <html
      lang="ko"
      className={`${display.variable} ${displayKr.variable} ${sans.variable}`}
    >
      <body>
        <header className="vh-header">
          <div className="vh-header-inner">
            <Link href="/" className="vh-brand">
              VERTHILL <span>• Caddy</span>
            </Link>

            <nav className="vh-nav">
              <Link className="ui-btn ui-btn-ghost" href="/">
                홈
              </Link>
              <Link className="ui-btn ui-btn-ghost" href="/notice">
                공지
              </Link>

              {role === "admin" && (
                <Link className="ui-btn ui-btn-gold" href="/manage">
                  관리자
                </Link>
              )}
              {role === "caddy" && (
                <Link className="ui-btn ui-btn-gold" href="/caddy">
                  내 대시보드
                </Link>
              )}

              {role ? (
                <LogoutButton />
              ) : (
                <Link className="ui-btn ui-btn-primary" href="/login">
                  로그인
                </Link>
              )}
            </nav>
          </div>
        </header>

        <main className="vh-main">{children}</main>
      </body>
    </html>
  );
}
