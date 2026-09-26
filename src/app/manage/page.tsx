import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { formatKstDisplay } from "@/lib/kstDate";
import AdminOpsDashboard from "@/components/manage/AdminOpsDashboard";

export const dynamic = "force-dynamic";

export default function ManagePage() {
  return (
    <>
      <AdminOpsDashboard />
      <section className="dash-glance">
        <div className="dash-glance-head">
          <h2 className="dash-glance-title">알림 설정</h2>
          <Link className="dash-link" href="/manage/notifications">
            이 기기 알림 받기
          </Link>
        </div>
        <p className="pt-sub" style={{ margin: 0, fontSize: "0.8rem", color: "var(--vh-muted)" }}>
          이 관리자 기기에 새 코스 제보 알림을 받습니다.
        </p>
      </section>
      <Suspense fallback={null}>
        <ManageDashboardNotices />
      </Suspense>
    </>
  );
}

async function ManageDashboardNotices() {
  const latestNotices = await prisma.notice.findMany({
    select: { id: true, title: true, createdAt: true, important: true, pinned: true },
    orderBy: [{ pinned: "desc" }, { important: "desc" }, { createdAt: "desc" }],
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
            <time>{formatKstDisplay(n.createdAt, "md-hm")}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
