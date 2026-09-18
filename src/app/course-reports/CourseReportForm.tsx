"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { COURSE_CODES, COURSE_LABELS, type CourseCode } from "@/lib/reservationParser";
import {
  COURSE_REPORT_CATEGORIES,
  COURSE_REPORT_CATEGORY_LABELS,
  type CourseReportCategoryCode,
} from "@/lib/courseReportConstants";
import type { CourseReportPhotoPublic } from "@/lib/courseReportPhotoConstants";
import { courseReportPhotoSrc } from "@/lib/courseReportPhotoConstants";
import {
  COURSE_REPORT_HEIC_MESSAGE,
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_MAX,
  isHeicLikeFile,
  prepareCourseReportPhoto,
} from "@/lib/courseReportPhotoClient";

type Props = {
  mode?: "new" | "edit";
  canManagePhotos?: boolean;
  initial?: {
    id: number;
    title: string;
    body: string;
    course: CourseCode;
    hole: number | null;
    category: CourseReportCategoryCode;
    photos?: CourseReportPhotoPublic[];
  };
};

type PendingPhoto = { key: string; blob: Blob; previewUrl: string };

export default function CourseReportForm({
  mode = "new",
  initial,
  canManagePhotos = true,
}: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [course, setCourse] = useState<CourseCode>(initial?.course ?? "VERTHILL");
  const [hole, setHole] = useState(initial?.hole != null ? String(initial.hole) : "");
  const [category, setCategory] = useState<CourseReportCategoryCode>(
    initial?.category ?? "COURSE_CONDITION"
  );
  const [busy, setBusy] = useState(false);
  const [statusNote, setStatusNote] = useState("");
  const [existingPhotos, setExistingPhotos] = useState<CourseReportPhotoPublic[]>(
    initial?.photos ?? []
  );
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const isEdit = mode === "edit";
  const totalPhotos = existingPhotos.length + pending.length;
  const canAdd = canManagePhotos && totalPhotos < COURSE_REPORT_PHOTO_MAX;

  async function onPick(files: FileList | null) {
    if (!files || !canManagePhotos) return;
    setStatusNote("");
    const room = COURSE_REPORT_PHOTO_MAX - existingPhotos.length - pending.length;
    const selected = Array.from(files).slice(0, Math.max(0, room));
    const additions: PendingPhoto[] = [];
    for (const file of selected) {
      if (isHeicLikeFile(file)) {
        setStatusNote(COURSE_REPORT_HEIC_MESSAGE);
        continue;
      }
      try {
        const blob = await prepareCourseReportPhoto(file);
        additions.push({
          key: `${Date.now()}-${additions.length}-${file.name}`,
          blob,
          previewUrl: URL.createObjectURL(blob),
        });
      } catch (e) {
        setStatusNote(e instanceof Error ? e.message : COURSE_REPORT_HEIC_MESSAGE);
      }
    }
    if (additions.length) {
      setPending((cur) => {
        const roomLeft = COURSE_REPORT_PHOTO_MAX - existingPhotos.length - cur.length;
        return [...cur, ...additions.slice(0, Math.max(0, roomLeft))];
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function removePending(key: string) {
    setPending((cur) => {
      const hit = cur.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return cur.filter((p) => p.key !== key);
    });
  }

  async function removeExisting(photoId: number) {
    if (!initial?.id || !canManagePhotos) return;
    const res = await fetch(`/api/course-reports/${initial.id}/photos/${photoId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(typeof data.message === "string" ? data.message : "사진 삭제 실패");
      return;
    }
    setExistingPhotos((cur) => cur.filter((p) => p.id !== photoId));
  }

  async function uploadPending(reportId: number): Promise<number> {
    let failed = 0;
    for (const item of pending) {
      const fd = new FormData();
      fd.append("file", item.blob, "photo.jpg");
      const res = await fetch(`/api/course-reports/${reportId}/photos`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) failed += 1;
    }
    return failed;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatusNote("");
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
    if (!res.ok) {
      setBusy(false);
      const data = await res.json().catch(() => ({}));
      alert(typeof data.message === "string" ? data.message : isEdit ? "수정 실패" : "등록 실패");
      return;
    }
    const data = await res.json().catch(() => ({}));
    const reportId = isEdit ? initial?.id : data.id;
    if (typeof reportId !== "number") {
      setBusy(false);
      router.replace("/course-reports");
      return;
    }
    let failed = 0;
    if (canManagePhotos && pending.length > 0) {
      failed = await uploadPending(reportId);
    }
    setBusy(false);
    if (failed > 0) {
      alert(
        isEdit
          ? `제보는 수정되었지만 사진 ${failed}장이 업로드되지 않았습니다.`
          : `제보는 등록되었지만 사진 ${failed}장이 업로드되지 않았습니다.`
      );
    }
    router.replace(`/course-reports/${reportId}`);
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

      {canManagePhotos ? (
        <fieldset className="course-report-fieldset">
          <legend>사진 (최대 {COURSE_REPORT_PHOTO_MAX}장)</legend>
          <div className="course-report-photo-composer">
            {existingPhotos.map((photo) => (
              <div key={photo.id} className="course-report-photo-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={courseReportPhotoSrc(initial!.id, photo.id)} alt="" />
                <button
                  type="button"
                  className="course-report-photo-remove"
                  aria-label="사진 삭제"
                  onClick={() => void removeExisting(photo.id)}
                >
                  ×
                </button>
              </div>
            ))}
            {pending.map((photo) => (
              <div key={photo.key} className="course-report-photo-item">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.previewUrl} alt="" />
                <button
                  type="button"
                  className="course-report-photo-remove"
                  aria-label="사진 삭제"
                  onClick={() => removePending(photo.key)}
                >
                  ×
                </button>
              </div>
            ))}
            <label className={`course-report-photo-add${canAdd ? "" : " is-disabled"}`}>
              + 사진
              <input
                ref={fileRef}
                type="file"
                accept={COURSE_REPORT_PHOTO_ACCEPT}
                multiple
                disabled={!canAdd || busy}
                onChange={(e) => void onPick(e.target.files)}
              />
            </label>
          </div>
          {statusNote ? <p className="course-report-photo-note">{statusNote}</p> : null}
        </fieldset>
      ) : null}

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
