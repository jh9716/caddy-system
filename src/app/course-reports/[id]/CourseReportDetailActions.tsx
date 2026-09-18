"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  COURSE_REPORT_STATUSES,
  COURSE_REPORT_STATUS_LABELS,
  type CourseReportStatusCode,
} from "@/lib/courseReportConstants";

export default function CourseReportDetailActions({
  id,
  canEdit,
  canDelete,
  canChangeStatus,
  status,
}: {
  id: number;
  canEdit: boolean;
  canDelete: boolean;
  canChangeStatus: boolean;
  status: CourseReportStatusCode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(status);

  async function onDelete() {
    if (!confirm("이 제보를 삭제할까요?")) return;
    setBusy(true);
    const res = await fetch(`/api/course-reports/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    setBusy(false);
    if (!res.ok) {
      alert("삭제 실패");
      return;
    }
    router.replace("/course-reports");
  }

  async function onStatus(next: CourseReportStatusCode) {
    if (next === current) return;
    setBusy(true);
    const res = await fetch(`/api/course-reports/${id}/status`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    if (!res.ok) {
      alert("상태 변경 실패");
      return;
    }
    setCurrent(next);
    router.refresh();
  }

  if (!canEdit && !canDelete && !canChangeStatus) return null;

  return (
    <div className="course-report-detail-actions">
      {canEdit ? (
        <a href={`/course-reports/${id}/edit`} className="ui-btn ui-btn-ghost">
          수정
        </a>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy}
          className="ui-btn ui-btn-danger"
        >
          {busy ? "삭제 중…" : "삭제"}
        </button>
      ) : null}
      {canChangeStatus ? (
        <div className="course-report-status-row" role="group" aria-label="처리상태">
          {COURSE_REPORT_STATUSES.map((code) => (
            <button
              key={code}
              type="button"
              disabled={busy}
              className={`course-report-chip${current === code ? " is-active" : ""}`}
              onClick={() => void onStatus(code)}
            >
              {COURSE_REPORT_STATUS_LABELS[code]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
