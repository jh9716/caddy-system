"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AdminOpsDashboard from "@/components/manage/AdminOpsDashboard";
import {
  opsWorkspaceHref,
  parseOpsWorkspaceDate,
  parseOpsWorkspaceView,
} from "@/lib/adminOpsWorkspace";

const ManageAvailabilityPanel = dynamic(
  () => import("@/components/manage/ManageAvailabilityPanel"),
  {
    ssr: false,
    loading: () => (
      <p className="ops-workspace-loading" aria-live="polite">
        가용표 준비 중…
      </p>
    ),
  }
);

export default function ManageOpsWorkspace({
  statusExtras,
}: {
  statusExtras?: ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseOpsWorkspaceView(params.get("view"));
  const date = parseOpsWorkspaceDate(params.get("date"));

  const setDate = useCallback(
    (ymd: string) => {
      router.replace(opsWorkspaceHref(view, ymd), { scroll: false });
    },
    [router, view]
  );

  return (
    <div className="ops-workspace" data-view={view}>
      <nav className="ops-workspace-tabs" aria-label="운영 화면">
        <WorkspaceTab
          href={opsWorkspaceHref("status", date)}
          active={view === "status"}
          label="캐디 현황"
        />
        <WorkspaceTab
          href={opsWorkspaceHref("availability", date)}
          active={view === "availability"}
          label="가용표"
        />
      </nav>

      {view === "status" ? (
        <>
          <AdminOpsDashboard date={date ?? undefined} onDateChange={setDate} />
          {statusExtras}
        </>
      ) : (
        <ManageAvailabilityPanel
          initialDate={date}
          onDateChange={setDate}
          loginCallback={opsWorkspaceHref("availability", date)}
        />
      )}
    </div>
  );
}

function WorkspaceTab({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={active ? "ops-workspace-tab is-active" : "ops-workspace-tab"}
      scroll={false}
    >
      {label}
    </Link>
  );
}
