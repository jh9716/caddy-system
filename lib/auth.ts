import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        const username = (creds?.username || "").trim();
        const password = creds?.password || "";

        // 1) DB 사용자 우선
        const dbUser = await prisma.user.findUnique({ where: { username } });
        if (dbUser) {
          const ok = await bcrypt.compare(password, dbUser.password);
          if (ok) {
            return { id: String(dbUser.id), name: dbUser.username, role: dbUser.role };
          }
        }

        // 2) .env 관리자/캐디(임시 백도어) — DB가 비어있을 때용
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
          return { id: "env-admin", name: "admin", role: "ADMIN" };
        }
        if (username === process.env.CADDY_USERNAME && password === process.env.CADDY_PASSWORD) {
          return { id: "env-caddy", name: "caddy", role: "STAFF" };
        }
        return null;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.role = (user as any).role ?? "STAFF";
      return token;
    },
    async session({ session, token }) {
      (session as any).role = (token as any).role ?? "STAFF";
      return session;
    },
  },
});
