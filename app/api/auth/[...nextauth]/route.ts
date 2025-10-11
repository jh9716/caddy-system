import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export const authOptions = {
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(creds) {
        if (!creds?.username || !creds?.password) return null;

        const user = await prisma.user.findUnique({
          where: { username: String(creds.username) },
        });
        if (!user) return null;

        const ok = await bcrypt.compare(String(creds.password), user.password);
        if (!ok) return null;

        // 반드시 문자열로
        return { id: String(user.id), name: user.username, role: user.role };
      },
    }),
  ],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

const handler = NextAuth(authOptions);

// ✅ App Router에서는 이렇게 내보냅니다.
export { handlers as GET, handlers as POST } from "@/lib/auth";
