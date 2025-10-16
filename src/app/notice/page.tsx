import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import Link from "next/link";
import dayjs from "dayjs";

export const dynamic = "force-dynamic";

export default async function NoticeListPage() {
  const role = (await cookies()).get("role")?.value ?? null;

  const notices = await prisma.notice.findMany({
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">공지</h1>
        {role === "admin" && (
          <Link
            href="/notice/new"
            className="rounded-md border px-3 py-1.5 hover:bg-slate-50"
          >
            새 공지
          </Link>
        )}
      </div>

      <ul className="divide-y rounded-xl border bg-white">
        {notices.map((n) => (
          <li key={n.id} className="flex items-center justify-between p-3">
            <a className="hover:underline" href={`/notice/${n.id}`}>
              {n.title}
            </a>
            <span className="text-xs text-slate-500">
              {dayjs(n.createdAt).format("YYYY-MM-DD HH:mm")}
            </span>
          </li>
        ))}
        {notices.length === 0 && (
          <li className="p-3 text-slate-500">등록된 공지가 없습니다.</li>
        )}
      </ul>
    </div>
  );
}
