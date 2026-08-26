import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import dayjs from "dayjs";
import { PRIMARY_TEAMS, normalizeEmploymentStatus } from "@/lib/caddyManage";

export const dynamic = "force-dynamic";

const GLANCE_TEAMS = PRIMARY_TEAMS;

type KpiHint = "people" | "off" | "sick" | "long" | "duty" | "marshal";
type KpiItem = { label: string; value: ReactNode; hint: KpiHint };
type TeamGlance = {
  team: string;
  total: number | null;
  active: number | null;
  leave: number | null;
  retired: number | null;
  other: number | null;
};

const KPI_META: { label: string; hint: KpiHint }[] = [
  { label: "총 캐디", hint: "people" },
  { label: "휴무", hint: "off" },
  { label: "병가", hint: "sick" },
  { label: "장기병가", hint: "long" },
  { label: "당번", hint: "duty" },
  { label: "마샬", hint: "marshal" },
];

const KPI_ICONS: Record<KpiHint, ReactNode> = {
  people: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  off: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  sick: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2v20M2 12h20" />
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  ),
  long: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M2 12h20M4 8h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z" />
      <path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  duty: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
    </svg>
  ),
  marshal: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2.5" />
    </svg>
  ),
};

/** Login/first paint: shell + dashboard chrome only. KPI queries stay in ManageDashboardData. */
export default function ManagePage() {
  return (
    <Suspense fallback={<ManageDashboardFallback />}>
      <ManageDashboardData />
    </Suspense>
  );
}

async function ManageDashboardData() {
  const today = dayjs().startOf("day").toDate();
  const tomorrow = dayjs(today).add(1, "day").toDate();

  const [
    totalCaddies,
    off,
    sick,
    longSick,
    duty,
    marshal,
    caddyRows,
    latestNotices,
  ] = await Promise.all([
    prisma.caddy.count({
      where: { employmentStatus: { in: ["ACTIVE", "LEAVE"] } },
    }),
    prisma.assignment.count({
      where: {
        type: "OFF",
        startDate: { lte: tomorrow },
        endDate: { gte: today },
      },
    }),
    prisma.assignment.count({
      where: {
        type: "SICK",
        startDate: { lte: tomorrow },
        endDate: { gte: today },
      },
    }),
    prisma.assignment.count({
      where: {
        type: "LONG_SICK",
        startDate: { lte: tomorrow },
        endDate: { gte: today },
      },
    }),
    prisma.assignment.count({
      where: {
        type: "DUTY",
        startDate: { lte: tomorrow },
        endDate: { gte: today },
      },
    }),
    prisma.assignment.count({
      where: {
        type: "MARSHAL",
        startDate: { lte: tomorrow },
        endDate: { gte: today },
      },
    }),
    prisma.caddy.findMany({
      select: { team: true, employmentStatus: true },
    }),
    prisma.notice.findMany({
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const teamMap = new Map(
    GLANCE_TEAMS.map((team) => [
      team,
      { team, total: 0, active: 0, leave: 0, retired: 0, other: 0 },
    ])
  );

  for (const row of caddyRows) {
    const bucket = teamMap.get(row.team);
    if (!bucket) continue;
    const st = normalizeEmploymentStatus(row.employmentStatus);
    if (st === "ACTIVE") bucket.active += 1;
    else if (st === "LEAVE") bucket.leave += 1;
    else if (st === "RETIRED") bucket.retired += 1;
    else bucket.other += 1;
    if (st === "ACTIVE" || st === "LEAVE") bucket.total += 1;
  }

  const teamGlance = GLANCE_TEAMS.map((t) => teamMap.get(t)!);
  const kpiValues = [totalCaddies, off, sick, longSick, duty, marshal];
  const kpis: KpiItem[] = KPI_META.map((meta, i) => ({
    ...meta,
    value: kpiValues[i]!,
  }));

  return (
    <ManageDashboardChrome
      kpis={kpis}
      teamGlance={teamGlance}
      latestNotices={latestNotices}
    />
  );
}

function ManageDashboardFallback() {
  const kpis: KpiItem[] = KPI_META.map((meta) => ({
    ...meta,
    value: <span className="dash-kpi-pending">—</span>,
  }));
  const teamGlance: TeamGlance[] = GLANCE_TEAMS.map((team) => ({
    team,
    total: null,
    active: null,
    leave: null,
    retired: null,
    other: null,
  }));

  return (
    <ManageDashboardChrome
      busy
      kpis={kpis}
      teamGlance={teamGlance}
      latestNotices={null}
    />
  );
}

function ManageDashboardChrome({
  busy = false,
  kpis,
  teamGlance,
  latestNotices,
}: {
  busy?: boolean;
  kpis: KpiItem[];
  teamGlance: TeamGlance[];
  latestNotices: { id: number; title: string; createdAt: Date }[] | null;
}) {
  return (
    <div className="dash" aria-busy={busy || undefined}>
      <div className="dash-scenic" aria-hidden>
        <div
          className="dash-scenic-img"
          style={{ backgroundImage: "url(/brand/strip-course.jpg)" }}
        />
        <div className="dash-scenic-veil" />
      </div>

      <header className="dash-top">
        <div>
          <h1 className="dash-title">관리자 대시보드</h1>
          <p className="dash-date">{dayjs().format("YYYY.MM.DD")}</p>
        </div>
        <div className="dash-top-right">
          <span className="dash-admin-chip">관리자님</span>
        </div>
      </header>

      <section className="dash-kpi" aria-label="오늘 현황">
        {kpis.map((k) => (
          <article key={k.label} className="dash-kpi-card" data-hint={k.hint}>
            <span className="dash-kpi-icon">{KPI_ICONS[k.hint]}</span>
            <div className="dash-kpi-label">{k.label}</div>
            <div className="dash-kpi-value">{k.value}</div>
          </article>
        ))}
      </section>

      <section className="dash-glance">
        <div className="dash-glance-head">
          <h2 className="dash-glance-title">한눈에 보기 (조별 현황)</h2>
          <Link href="/manage/caddies" className="dash-link">
            상세 보기 →
          </Link>
        </div>
        <div className="dash-glance-row">
          {teamGlance.map((t) => (
            <Link
              key={t.team}
              href="/manage/caddies"
              className="dash-team-mini"
            >
              <div className="dash-team-name">{t.team}</div>
              <div className="dash-dots">
                <span className="dot active" title="재직">
                  {t.active ?? "—"}
                </span>
                <span className="dot leave" title="휴직">
                  {t.leave ?? "—"}
                </span>
                <span className="dot retired" title="삭제됨">
                  {t.retired ?? "—"}
                </span>
                <span className="dot other" title="기타">
                  {t.other ?? "—"}
                </span>
              </div>
              <div className="dash-team-total">
                {t.total == null ? "—" : `${t.total}명`}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="dash-notices">
        <h2 className="dash-glance-title">최근 공지</h2>
        <ul>
          {latestNotices && latestNotices.length === 0 && (
            <li className="dash-empty">공지 없음</li>
          )}
          {latestNotices?.map((n) => (
            <li key={n.id}>
              <Link href={`/notice/${n.id}`}>{n.title}</Link>
              <time>{dayjs(n.createdAt).format("MM-DD HH:mm")}</time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
