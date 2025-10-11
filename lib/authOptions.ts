import type { NextAuthOptions } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: { username: { label: "Username" }, password: { label: "Password", type: "password" } },
      async authorize(creds) {
        const username = (creds?.username || "").trim();
        const password = creds?.password || "";
        const dbUser = await prisma.user.findUnique({ where: { username } });
        if (dbUser && (await bcrypt.compare(password, dbUser.password))) {
          return { id: String(dbUser.id), name: dbUser.username, role: dbUser.role } as any;
        }
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD)
          return { id: "env-admin", name: "admin", role: "ADMIN" } as any;
        if (username === process.env.CADDY_USERNAME && password === process.env.CADDY_PASSWORD)
          return { id: "env-caddy", name: "caddy", role: "STAFF" } as any;
        return null;
      }
    })
  ],
  callbacks: {
    async jwt({ token, user }) { if (user) token.role = (user as any).role ?? "STAFF"; return token; },
    async session({ session, token }) { (session as any).role = (token as any).role ?? "STAFF"; return session; }
  }
};
