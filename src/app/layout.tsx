import "./globals.css";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Cormorant_Garamond, Noto_Serif_KR, Source_Sans_3 } from "next/font/google";
import AppHeader from "@/components/AppHeader";
import MemberShell from "@/components/manage/MemberShell";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { shouldUseMemberShell } from "@/lib/boardNav";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";
import {
  PWA_APPLE_TOUCH_ICON,
  PWA_ICON_192,
  PWA_ICON_512,
  PWA_NAME,
  PWA_SPLASH_PORTRAIT,
  PWA_THEME_COLOR,
} from "@/lib/pwaManifest";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  applicationName: PWA_NAME,
  title: {
    default: PWA_NAME,
    template: `%s · ${PWA_NAME}`,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: PWA_ICON_192, sizes: "192x192", type: "image/png" },
      { url: PWA_ICON_512, sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: PWA_APPLE_TOUCH_ICON, sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: PWA_NAME,
    statusBarStyle: "black-translucent",
    startupImage: [PWA_SPLASH_PORTRAIT],
  },
};

export const viewport: Viewport = {
  themeColor: PWA_THEME_COLOR,
  width: "device-width",
  initialScale: 1,
};

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
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <ServiceWorkerRegister />
        {shouldUseMemberShell(role) ? (
          <MemberShell>{children}</MemberShell>
        ) : (
          <>
            <AppHeader role={role} />
            <main className="vh-main">{children}</main>
          </>
        )}
      </body>
    </html>
  );
}
