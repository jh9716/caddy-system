import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import dayjs from "dayjs";

export const dynamic = "force-dynamic";

export default async function ManagePage() {
  const role = (await cookies()).get("role")?.value ?? null;
  if (role !== "admin") redirect("/login");

  const today = dayjs().startOf("day").toDate();
  const tomorrow = dayjs(today).add(1, "day").toDate();

  const [
    totalCaddies,
    off,
    sick,
    longSick,
    duty,
    marshal,
    latestNotices,
  ] = await Promise.all([
    prisma.caddy.count(),
    prisma.assignment.count({
      where: { type: "OFF", startDate: { lte: tomorrow }, endDate: { gte: today } },
    }),
    prisma.assignment.count({
      where: { type: "SICK", startDate: { lte: tomorrow }, endDate: { gte: today } },
    }),
    prisma.assignment.count({
      where: { type: "LONG_SICK", startDate: { lte: tomorrow }, endDate: { gte: today } },
    }),
    prisma.assignment.count({
      where: { type: "DUTY", startDate: { lte: tomorrow }, endDate: { gte: today } },
    }),
    prisma.assignment.count({
      where: { type: "MARSHAL", startDate: { lte: tomorrow }, endDate: { gte: today } },
    }),
    prisma.notice.findMany({
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">관리자 대시보드</h2>
        <p className="text-slate-500">{dayjs().format("YYYY-MM-DD")} 요약</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Card title="총 캐디" value={totalCaddies} />
        <Card title="휴무" value={off} />
        <Card title="병가" value={sick} />
        <Card title="장기병가" value={longSick} />
        <Card title="당번" value={duty} />
        <Card title="마샬" value={marshal} />
      </div>

      <section className="mt-4">
        <h3 className="mb-2 text-lg font-semibold">최근 공지</h3>
        <ul className="divide-y rounded-xl border bg-white">
          {latestNotices.length === 0 && (
            <li className="p-3 text-slate-500">공지 없음</li>
          )}
          {latestNotices.map((n) => (
            <li key={n.id} className="p-3">
              <a className="hover:underline" href={`/notice/${n.id}`}>
                {n.title}
              </a>
              <span className="ml-2 text-xs text-slate-500">
                {dayjs(n.createdAt).format("YYYY-MM-DD HH:mm")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Card({ title, value }: { title: string; value: number }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-xs text-slate-500">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
