import "./globals.css";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "@fontsource/cormorant-garamond/500.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/700.css";
import "@fontsource/noto-serif-kr/500.css";
import "@fontsource/noto-serif-kr/600.css";
import "@fontsource/noto-serif-kr/700.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";
import AppHeader from "@/components/AppHeader";
import MemberShell from "@/components/manage/MemberShell";
import AndroidSystemBackBootstrap from "@/components/AndroidSystemBackBootstrap";
import ChatPushOnboarding from "@/components/ChatPushOnboarding";
import NativePushBootstrap from "@/components/NativePushBootstrap";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { shouldUseMemberShell } from "@/lib/boardNav";
import FloatingChat from "@/components/chat/FloatingChat";
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const role = (await getVerifiedSessionFromCookies(store))?.role ?? null;

  return (
    <html lang="ko">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <ServiceWorkerRegister />
        <NativePushBootstrap />
        <ChatPushOnboarding />
        <AndroidSystemBackBootstrap />
        {shouldUseMemberShell(role) ? (
          <MemberShell>{children}</MemberShell>
        ) : (
          <>
            <AppHeader role={role} />
            <main className="vh-main">{children}</main>
          </>
        )}
        <FloatingChat role={role} />
      </body>
    </html>
  );
}
