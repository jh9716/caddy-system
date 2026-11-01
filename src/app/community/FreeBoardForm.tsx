"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { prepareFreeBoardPhoto } from "@/lib/freeBoardPhotoClient";
import {
  courseReportPhotoBlobFingerprint,
  courseReportPhotoFileId,
  isHeicLikeFile,
  COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE,
} from "@/lib/courseReportPhotoClient";
import {
  FREE_BOARD_BODY_MAX,
  FREE_BOARD_PHOTO_ACCEPT,
  FREE_BOARD_PHOTO_MAX,
  FREE_BOARD_TITLE_MAX,
  freeBoardPhotoSrc,
  type FreeBoardPhotoPublic,
} from "@/lib/freeBoardConstants";
import {
  newFreeBoardUploadKey,
  uploadFreeBoardPhotos,
  type FreeBoardUploadItem,
} from "@/lib/freeBoardUploadClient";
import {
  consumeUnauthorizedMemberResponse,
  isMemberSessionRedirectScheduled,
} from "@/lib/memberSessionRedirect";

type Pending = FreeBoardUploadItem & { previewUrl: string; fileId: string; fingerprint: string; name: string };
/** 변환/디코딩 실패 사진: 목록에 파일명 + 사유로 표시 (업로드 대상 아님). */
type PickFailure = { key: string; name: string; message: string; heic: boolean };

const MAX_NOTE = `사진은 최대 ${FREE_BOARD_PHOTO_MAX}장까지 첨부할 수 있습니다.`;
const LEAVE_CONFIRM = "사진 업로드가 끝나지 않았습니다. 이 페이지를 떠나면 업로드가 중단됩니다. 떠나시겠습니까?";

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
  const [pickFailures, setPickFailures] = useState<PickFailure[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState("");
  /** 글 저장(POST/PATCH)이 이미 끝난 게시글 id. 재시도 시 글을 다시 만들지 않는다. */
  const [savedPostId, setSavedPostId] = useState<number | null>(null);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;
  const kept = existing.filter((p) => !removedIds.includes(p.id));
  const total = kept.length + pending.length;
  const canAdd = total < FREE_BOARD_PHOTO_MAX;
  const failedCount = pending.filter((p) => p.status === "failed").length;
  /** 업로드 중이거나, 글은 저장됐는데 사진이 남은 상태 → 이탈 경고 */
  const guardLeave = busy || preparing > 0 || (savedPostId !== null && pending.some((p) => p.status !== "done"));

  // 미리보기 object URL 은 컴포넌트가 사라질 때만 해제 (표시 중 해제 → 빈 썸네일 방지)
  useEffect(() => {
    return () => {
      for (const p of pendingRef.current) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  // 이탈 방지: 새로고침/탭 닫기 + 앱 내 링크 클릭
  useEffect(() => {
    if (!guardLeave) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a || e.defaultPrevented) return;
      if (!window.confirm(LEAVE_CONFIRM)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [guardLeave]);

  function onAddClick() {
    if (busy) return;
    if (!canAdd) {
      setNote(`${MAX_NOTE} 다른 사진을 넣으려면 기존 사진을 먼저 삭제해 주세요.`);
      return;
    }
    fileRef.current?.click();
  }

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    if (fileRef.current) fileRef.current.value = "";
    setNote("");
    const room = FREE_BOARD_PHOTO_MAX - kept.length - pendingRef.current.length;
    if (room <= 0) {
      setNote(MAX_NOTE);
      return;
    }
    const take = list.slice(0, room);
    if (list.length > room) setNote(`${MAX_NOTE} ${list.length - room}장은 제외되었습니다.`);
    setPreparing((n) => n + take.length);
    const seenIds = new Set(pendingRef.current.map((p) => p.fileId));
    const seenPrints = new Set(pendingRef.current.map((p) => p.fingerprint));
    for (const file of take) {
      try {
        const fileId = courseReportPhotoFileId(file);
        if (seenIds.has(fileId)) {
          setNote(COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE);
          continue;
        }
        let blob: Blob;
        try {
          blob = await prepareFreeBoardPhoto(file);
        } catch (e) {
          const heic = isHeicLikeFile(file);
          setPickFailures((cur) => [
            ...cur,
            {
              key: `${Date.now()}-${cur.length}-${fileId}`,
              name: file.name || "사진",
              heic,
              message:
                e instanceof Error && e.message
                  ? e.message
                  : heic
                    ? "HEIC 사진을 변환할 수 없습니다. JPG로 다시 선택해 주세요."
                    : "사진을 읽을 수 없습니다.",
            },
          ]);
          continue;
        }
        const fingerprint = await courseReportPhotoBlobFingerprint(blob);
        if (seenPrints.has(fingerprint)) {
          setNote(COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE);
          continue;
        }
        seenIds.add(fileId);
        seenPrints.add(fingerprint);
        const item: Pending = {
          key: `${Date.now()}-${fileId}`,
          uploadKey: newFreeBoardUploadKey(),
          blob,
          status: "ready",
          previewUrl: URL.createObjectURL(blob),
          fileId,
          fingerprint,
          name: file.name || "사진",
        };
        setPending((cur) => {
          if (kept.length + cur.length >= FREE_BOARD_PHOTO_MAX) {
            URL.revokeObjectURL(item.previewUrl);
            return cur;
          }
          return [...cur, item];
        });
      } finally {
        setPreparing((n) => Math.max(0, n - 1));
      }
    }
  }

  function removePending(key: string) {
    if (busy) return;
    setPending((cur) => {
      const hit = cur.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return cur.filter((p) => p.key !== key);
    });
  }

  /** 서버 삭제 없이 표시만 (취소 시 원복). */
  function toggleRemoveExisting(photoId: number) {
    if (busy || savedPostId !== null) return;
    setRemovedIds((cur) =>
      cur.includes(photoId) ? cur.filter((id) => id !== photoId) : [...cur, photoId]
    );
  }

  function patchItem(key: string, patch: Partial<FreeBoardUploadItem>) {
    setPending((cur) => cur.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function finish(postId: number) {
    router.replace(`/community/${postId}`);
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (preparing > 0) {
      setNote("사진을 준비하는 중입니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    if (!title.trim() || !body.trim()) {
      setNote("제목과 안내 내용을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setNote("");
    let postId = savedPostId;
    if (postId === null) {
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
        setNote("네트워크 오류로 저장하지 못했습니다. 작성 내용은 그대로 있으니 다시 시도해 주세요.");
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
      const id = isEdit ? initial?.id : data.id;
      if (typeof id !== "number") {
        setBusy(false);
        router.replace("/community");
        return;
      }
      postId = id;
      setSavedPostId(id);
    }
    const todo = pendingRef.current.filter((p) => p.status !== "done");
    if (todo.length === 0) {
      setBusy(false);
      finish(postId);
      return;
    }
    const result = await uploadFreeBoardPhotos(postId, pendingRef.current, {
      onItem: patchItem,
      onProgress: (done, totalN) => setProgress({ done, total: totalN }),
    });
    setProgress(null);
    if (result.unauthorized || isMemberSessionRedirectScheduled()) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result.failed > 0) {
      setNote(
        `가배치표 글은 저장되었지만 사진 ${result.failed}장이 업로드되지 않았습니다. 실패한 사진만 다시 올리거나, 사진 없이 완료할 수 있습니다.`
      );
      return;
    }
    // 모두 성공 → 이탈 경고 해제 후 이동
    setSavedPostId(null);
    finish(postId);
  }

  const submitLabel = busy
    ? progress && progress.total > 0
      ? `사진 업로드 ${Math.min(progress.done + 1, progress.total)}/${progress.total}`
      : isEdit
        ? "수정 중…"
        : "등록 중…"
    : preparing > 0
      ? `사진 준비 중… (${preparing})`
      : savedPostId !== null && failedCount > 0
        ? `실패한 사진 ${failedCount}장 다시 올리기`
        : isEdit
          ? "수정"
          : "가배치표 올리기";

  return (
    <form onSubmit={onSubmit} className="course-report-form free-board-form">
      <label className="course-report-field">
        <span>제목</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="예: 11월 2일(월) 가배치표"
          required
          maxLength={FREE_BOARD_TITLE_MAX}
        />
      </label>
      <label className="course-report-field">
        <span>내용</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="안내 사항 (변경·주의 사항 등)"
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
                <img src={freeBoardPhotoSrc(initial!.id, photo.id)} alt="" className="is-revealed" />
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
          {pending.map((photo, index) => (
            <div
              key={photo.key}
              className={`course-report-photo-item free-board-photo-pending is-${photo.status}`}
              data-status={photo.status}
            >
              {/* object URL 은 즉시 표시 (is-revealed: 공용 CSS 의 opacity:0 페이드 대상에서 제외) */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.previewUrl} alt={`선택한 사진 ${index + 1}`} className="is-revealed" />
              {photo.status === "uploading" ? <span className="free-board-photo-badge">업로드 중</span> : null}
              {photo.status === "done" ? <span className="free-board-photo-badge is-ok">완료</span> : null}
              {photo.status === "failed" ? (
                <span className="free-board-photo-badge is-fail" title={photo.error}>
                  실패
                </span>
              ) : null}
              {photo.status !== "done" ? (
                <button
                  type="button"
                  className="course-report-photo-remove"
                  aria-label="사진 삭제"
                  disabled={busy}
                  onClick={() => removePending(photo.key)}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {Array.from({ length: preparing }, (_, i) => (
            <div key={`prep-${i}`} className="course-report-photo-item free-board-photo-preparing" aria-live="polite">
              <span>준비 중…</span>
            </div>
          ))}
          <button
            type="button"
            className={`course-report-photo-add free-board-photo-add${canAdd ? "" : " is-full"}`}
            aria-disabled={busy}
            onClick={onAddClick}
          >
            {canAdd ? "+ 사진" : `최대 ${FREE_BOARD_PHOTO_MAX}장`}
          </button>
          <input
            ref={fileRef}
            type="file"
            className="free-board-photo-input"
            accept={FREE_BOARD_PHOTO_ACCEPT}
            multiple
            hidden
            onChange={(e) => void onPick(e.target.files)}
          />
        </div>
        {!canAdd ? <p className="course-report-photo-note">{MAX_NOTE}</p> : null}
        {pickFailures.length ? (
          <ul className="free-board-photo-failures">
            {pickFailures.map((f) => (
              <li key={f.key}>
                <span className="free-board-photo-failname">{f.name}</span> — {f.message}
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost"
                  onClick={() => setPickFailures((cur) => cur.filter((x) => x.key !== f.key))}
                >
                  닫기
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {failedCount > 0 && !busy ? (
          <ul className="free-board-photo-failures" aria-live="polite">
            {pending
              .map((p, i) => ({ p, i }))
              .filter(({ p }) => p.status === "failed")
              .map(({ p, i }) => (
                <li key={p.key}>
                  사진 {i + 1} ({p.name}) 업로드 실패{p.error ? `: ${p.error}` : ""}
                </li>
              ))}
          </ul>
        ) : null}
        {progress && progress.total > 0 ? (
          <p className="course-report-photo-note" aria-live="polite">
            사진 업로드 {Math.min(progress.done + 1, progress.total)}/{progress.total} — 완료될 때까지 화면을 닫지 마세요.
          </p>
        ) : null}
        {removedIds.length ? (
          <p className="course-report-photo-note">
            사진 {removedIds.length}장은 저장하면 삭제됩니다. 취소하면 그대로 유지됩니다.
          </p>
        ) : null}
        {note ? <p className="course-report-photo-note">{note}</p> : null}
      </fieldset>
      <div className="course-report-form-actions">
        <button type="submit" disabled={busy || preparing > 0} className="ui-btn ui-btn-primary">
          {submitLabel}
        </button>
        {savedPostId !== null && failedCount > 0 && !busy ? (
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            onClick={() => {
              const id = savedPostId;
              setSavedPostId(null);
              finish(id);
            }}
          >
            사진 없이 완료
          </button>
        ) : (
          <a href={isEdit ? `/community/${initial?.id}` : "/community"} className="ui-btn ui-btn-ghost">
            취소
          </a>
        )}
      </div>
    </form>
  );
}
