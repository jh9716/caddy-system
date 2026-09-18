"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { COURSE_CODES, COURSE_LABELS, type CourseCode } from "@/lib/reservationParser";
import {
  COURSE_REPORT_CATEGORIES,
  COURSE_REPORT_CATEGORY_LABELS,
  type CourseReportCategoryCode,
} from "@/lib/courseReportConstants";

type Props = {
  mode?: "new" | "edit";
  initial?: {
    id: number;
    title: string;
    body: string;
    course: CourseCode;
    hole: number | null;
    category: CourseReportCategoryCode;
  };
};

export default function CourseReportForm({ mode = "new", initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [course, setCourse] = useState<CourseCode>(initial?.course ?? "VERTHILL");
  const [hole, setHole] = useState(initial?.hole != null ? String(initial.hole) : "");
  const [category, setCategory] = useState<CourseReportCategoryCode>(
    initial?.category ?? "COURSE_CONDITION"
  );
  const [busy, setBusy] = useState(false);
  const isEdit = mode === "edit";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const payload = {
      title,
      body,
      course,
      hole: hole.trim() ? Number(hole) : null,
      category,
    };
    const url = isEdit ? `/api/course-reports/${initial?.id}` : "/api/course-reports";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(typeof data.message === "string" ? data.message : isEdit ? "수정 실패" : "등록 실패");
      return;
    }
    if (isEdit) {
      router.replace(`/course-reports/${initial?.id}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (typeof data.id === "number") {
      router.replace(`/course-reports/${data.id}`);
    } else {
      router.replace("/course-reports");
    }
  }

  return (
    <form onSubmit={onSubmit} className="course-report-form">
      <fieldset className="course-report-fieldset">
        <legend>카테고리</legend>
        <div className="course-report-chips">
          {COURSE_REPORT_CATEGORIES.map((code) => (
            <button
              key={code}
              type="button"
              className={`course-report-chip${category === code ? " is-active" : ""}`}
              onClick={() => setCategory(code)}
            >
              {COURSE_REPORT_CATEGORY_LABELS[code]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="course-report-fieldset">
        <legend>코스</legend>
        <div className="course-report-chips">
          {COURSE_CODES.map((code) => (
            <button
              key={code}
              type="button"
              className={`course-report-chip${course === code ? " is-active" : ""}`}
              onClick={() => setCourse(code)}
            >
              {COURSE_LABELS[code]}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="course-report-field">
        <span>홀 (선택)</span>
        <input
          inputMode="numeric"
          value={hole}
          onChange={(e) => setHole(e.target.value)}
          placeholder="비우거나 1~18"
        />
      </label>

      <label className="course-report-field">
        <span>제목</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목"
          required
          maxLength={120}
        />
      </label>

      <label className="course-report-field">
        <span>내용</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="내용"
          required
          maxLength={4000}
        />
      </label>

      <div className="course-report-form-actions">
        <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">
          {busy ? (isEdit ? "수정 중…" : "등록 중…") : isEdit ? "수정" : "등록"}
        </button>
        <a
          href={isEdit ? `/course-reports/${initial?.id}` : "/course-reports"}
          className="ui-btn ui-btn-ghost"
        >
          취소
        </a>
      </div>
    </form>
  );
}
