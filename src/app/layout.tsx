import "./globals.css";
import { cookies } from "next/headers";
import { Cormorant_Garamond, Noto_Serif_KR, Source_Sans_3 } from "next/font/google";
import AppHeader from "@/components/AppHeader";
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
        <AppHeader role={role} />
        <main className="vh-main">{children}</main>
      </body>
    </html>
  );
}
