"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { pickCourseReportPhotos } from "@/lib/courseReportPhotoClient";
import {
  FREE_BOARD_BODY_MAX,
  FREE_BOARD_PHOTO_ACCEPT,
  FREE_BOARD_PHOTO_MAX,
  FREE_BOARD_TITLE_MAX,
  freeBoardPhotoSrc,
  type FreeBoardPhotoPublic,
} from "@/lib/freeBoardConstants";
import {
  consumeUnauthorizedMemberResponse,
  isMemberSessionRedirectScheduled,
} from "@/lib/memberSessionRedirect";

type Pending = { key: string; blob: Blob; previewUrl: string; fileId: string; fingerprint: string };

async function uploadPendingPhotos(postId: number, items: { blob: Blob }[]) {
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const blob = items[i].blob;
    const mime = (blob.type || "image/jpeg").toLowerCase();
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const fd = new FormData();
    fd.append("file", blob, `photo-${i}.${ext}`);
    let res: Response;
    try {
      res = await fetch(`/api/free-board/${postId}/photos`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
    } catch {
      failed += 1;
      continue;
    }
    if (consumeUnauthorizedMemberResponse(res)) return failed + (items.length - i);
    if (!res.ok) failed += 1;
  }
  return failed;
}

export default function FreeBoardForm({
  mode = "new",
  initial,
}: {
  mode?: "new" | "edit";
  initial?: { id: number; title: string; body: string; photos: FreeBoardPhotoPublic[] };
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const isEdit = mode === "edit";
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [existing] = useState<FreeBoardPhotoPublic[]>(initial?.photos ?? []);
  /** 수정 화면에서 삭제 표시만 한 사진. 최종 저장 시 서버에 removedPhotoIds 로 전달, 취소하면 버려짐. */
  const [removedIds, setRemovedIds] = useState<number[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const kept = existing.filter((p) => !removedIds.includes(p.id));
  const total = kept.length + pending.length;
  const canAdd = total < FREE_BOARD_PHOTO_MAX;

  async function onPick(files: FileList | null) {
    if (!files) return;
    setNote("");
    const room = FREE_BOARD_PHOTO_MAX - kept.length - pending.length;
    if (files.length > room) setNote(`사진은 최대 ${FREE_BOARD_PHOTO_MAX}장까지 첨부할 수 있습니다.`);
    const picked = await pickCourseReportPhotos(Array.from(files), room, undefined, {
      fileIds: pending.map((p) => p.fileId),
      fingerprints: pending.map((p) => p.fingerprint),
    });
    if (picked.note) setNote(picked.note);
    if (picked.items.length) {
      setPending((cur) => {
        const left = FREE_BOARD_PHOTO_MAX - kept.length - cur.length;
        return [...cur, ...picked.items.slice(0, Math.max(0, left))];
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

  /** 서버 삭제 없이 표시만 (취소 시 원복). */
  function toggleRemoveExisting(photoId: number) {
    setRemovedIds((cur) =>
      cur.includes(photoId) ? cur.filter((id) => id !== photoId) : [...cur, photoId]
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!title.trim() || !body.trim()) {
      setNote("제목과 내용을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setNote("");
    let res: Response;
    try {
      res = await fetch(isEdit ? `/api/free-board/${initial?.id}` : "/api/free-board", {
      method: isEdit ? "PATCH" : "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isEdit ? { title, body, removedPhotoIds: removedIds } : { title, body }),
      });
    } catch {
      setBusy(false);
      setNote("네트워크 오류로 저장하지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    if (consumeUnauthorizedMemberResponse(res)) {
      setBusy(false);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBusy(false);
      setNote(typeof data.message === "string" ? data.message : isEdit ? "수정 실패" : "등록 실패");
      return;
    }
    const postId = isEdit ? initial?.id : data.id;
    if (typeof postId !== "number") {
      setBusy(false);
      router.replace("/community");
      return;
    }
    const failed = pending.length ? await uploadPendingPhotos(postId, pending) : 0;
    if (isMemberSessionRedirectScheduled()) return;
    setBusy(false);
    if (failed > 0) alert(`글은 저장되었지만 사진 ${failed}장이 업로드되지 않았습니다.`);
    router.replace(`/community/${postId}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="course-report-form free-board-form">
      <label className="course-report-field">
        <span>제목</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목"
          required
          maxLength={FREE_BOARD_TITLE_MAX}
        />
      </label>
      <label className="course-report-field">
        <span>내용</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="내용"
          required
          maxLength={FREE_BOARD_BODY_MAX}
        />
      </label>
      <fieldset className="course-report-fieldset">
        <legend>
          사진 ({total}/{FREE_BOARD_PHOTO_MAX})
        </legend>
        <div className="course-report-photo-composer free-board-photo-composer">
          {existing.map((photo) => {
            const marked = removedIds.includes(photo.id);
            return (
              <div
                key={photo.id}
                className={`course-report-photo-item${marked ? " free-board-photo-marked" : ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={freeBoardPhotoSrc(initial!.id, photo.id)} alt="" />
                <button
                  type="button"
                  className="course-report-photo-remove"
                  aria-label={marked ? "사진 삭제 취소" : "사진 삭제 (저장 시 반영)"}
                  aria-pressed={marked}
                  onClick={() => toggleRemoveExisting(photo.id)}
                >
                  {marked ? "↺" : "×"}
                </button>
              </div>
            );
          })}
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
              accept={FREE_BOARD_PHOTO_ACCEPT}
              multiple
              disabled={!canAdd || busy}
              onChange={(e) => void onPick(e.target.files)}
            />
          </label>
        </div>
        {removedIds.length ? (
          <p className="course-report-photo-note">
            사진 {removedIds.length}장은 저장하면 삭제됩니다. 취소하면 그대로 유지됩니다.
          </p>
        ) : null}
        {note ? <p className="course-report-photo-note">{note}</p> : null}
      </fieldset>
      <div className="course-report-form-actions">
        <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">
          {busy ? (isEdit ? "수정 중…" : "등록 중…") : isEdit ? "수정" : "등록"}
        </button>
        <a href={isEdit ? `/community/${initial?.id}` : "/community"} className="ui-btn ui-btn-ghost">
          취소
        </a>
      </div>
    </form>
  );
}
