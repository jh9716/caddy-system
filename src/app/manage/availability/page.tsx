"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ManageAvailabilityPanel from "@/components/manage/ManageAvailabilityPanel";
import {
  availabilityStandaloneHref,
  parseOpsWorkspaceDate,
} from "@/lib/adminOpsWorkspace";

export default function ManageAvailabilityPage() {
  return (
    <Suspense fallback={<div className="av-page" />}>
      <AvailabilityRoute />
    </Suspense>
  );
}

function AvailabilityRoute() {
  const router = useRouter();
  const params = useSearchParams();
  const initialDate = parseOpsWorkspaceDate(params.get("date"));
  return (
    <ManageAvailabilityPanel
      initialDate={initialDate}
      loginCallback="/manage/availability"
      onDateChange={(ymd) => {
        router.replace(availabilityStandaloneHref(ymd), { scroll: false });
      }}
    />
  );
}
