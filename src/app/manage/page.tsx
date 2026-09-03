import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import dayjs from "dayjs";
import Link from "next/link";
import AdminOpsDashboard from "@/components/manage/AdminOpsDashboard";

export const dynamic = "force-dynamic";

export default function ManagePage() {
  return (
    <>
      <AdminOpsDashboard />
      <Suspense fallback={null}>
        <ManageDashboardNotices />
      </Suspense>
    </>
  );
}

async function ManageDashboardNotices() {
  const latestNotices = await prisma.notice.findMany({
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return (
    <section className="dash-notices">
      <h2 className="dash-glance-title">최근 공지</h2>
      <ul>
        {latestNotices.length === 0 && <li className="dash-empty">공지 없음</li>}
        {latestNotices.map((n) => (
          <li key={n.id}>
            <Link href={`/notice/${n.id}`}>{n.title}</Link>
            <time>{dayjs(n.createdAt).format("MM-DD HH:mm")}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
