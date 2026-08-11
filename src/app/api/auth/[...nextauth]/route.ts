// src/app/api/auth/[...nextauth]/route.ts
import type { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { normalizeAppRole } from "@/lib/sessionCookies";
import { verifyUserPassword } from "@/lib/userPassword";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// 로컬 HTTP에서는 Secure 쿠키를 쓰면 깨지므로 NEXTAUTH_URL이 https일 때만 Secure
const useSecureCookies = process.env.NEXTAUTH_URL?.startsWith("https://") === true;

export const authOptions: NextAuthOptions = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  // Cloudflare 터널 등 동적 호스트에서 localhost NEXTAUTH_URL 고정을 완화
  // (next-auth v4: AUTH_TRUST_HOST / NEXTAUTH_URL 조합)
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "ID", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        if (!creds?.username || !creds?.password) return null;

        // env 계정 허용 (로컬 테스트)
        const adminUser = process.env.ADMIN_USER || process.env.ADMIN_USERNAME || "admin";
        const adminPass = process.env.ADMIN_PASSWORD || "";
        if (
          creds.username === adminUser &&
          adminPass &&
          creds.password === adminPass
        ) {
          return { id: "env-admin", name: adminUser, role: "admin" };
        }

        const user = await prisma.user.findUnique({
          where: { username: creds.username },
        });
        if (!user) return null;
        // password null(OAuth 전용) → bcrypt 미호출, 로그인 거부
        const ok = await verifyUserPassword(creds.password, user.password);
        if (!ok) return null;
        const role = normalizeAppRole(user.role);
        if (!role) return null;

        return { id: String(user.id), name: user.username, role };
      },
    }),
  ],
  cookies: {
    sessionToken: {
      name: useSecureCookies
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.role = (user as any).role;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).user = {
        id: token.id,
        username: token.name,
        role: token.role,
      };
      return session;
    },
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST, handler as HEAD };
