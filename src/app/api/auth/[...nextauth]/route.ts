// src/app/api/auth/[...nextauth]/route.ts
import type { NextAuthOptions } from "next-auth";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { passwordLogin } from "@/lib/passwordLogin";

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

        const result = await passwordLogin(
          String(creds.username),
          String(creds.password),
          prisma
        );
        if (result.status === "unavailable") {
          throw new Error("auth_unavailable");
        }
        if (result.status !== "ok") return null;

        if (result.source === "env") {
          return {
            id: result.role === "admin" ? "env-admin" : "env-caddy",
            name: result.username,
            role: result.role,
          };
        }

        return {
          id: String(result.userId),
          name: result.username,
          role: result.role,
        };
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
