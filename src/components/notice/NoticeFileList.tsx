"use client";

import { useState } from "react";
import { canInlineNoticeFile, type NoticeFilePublic } from "@/lib/noticeFileConstants";
import { downloadNoticeFile, formatNoticeFileSize, openNoticeFile } from "@/lib/noticeFileClient";
import { readCapacitorNativePlatform } from "@/lib/nativePlatformClient";

export default function NoticeFileList({
  noticeId,
  files,
}: {
  noticeId: number;
  files: NoticeFilePublic[];
}) {
  const [note, setNote] = useState("");
  const [noteOk, setNoteOk] = useState(false);
  const [busyFileId, setBusyFileId] = useState<number | null>(null);
  if (files.length === 0) return null;

  async function run(
    action: "open" | "download",
    file: NoticeFilePublic
  ) {
    if (busyFileId != null) return;
    setNote("");
    setNoteOk(false);
    setBusyFileId(file.id);
    const native = readCapacitorNativePlatform();
    try {
      if (action === "download") {
        const outcome = await downloadNoticeFile({
          noticeId,
          fileId: file.id,
          originalName: file.originalName,
          mimeType: file.mimeType,
          native,
        });
        if (outcome.confirmed === true) {
          setNoteOk(true);
          setNote(
            outcome.displayName
              ? `다운로드 폴더에 저장했습니다. (${outcome.displayName})`
              : "다운로드 폴더에 저장했습니다."
          );
        }
        return;
      }
      await openNoticeFile({
        noticeId,
        fileId: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        native,
      });
    } catch (e) {
      setNoteOk(false);
      setNote(e instanceof Error ? e.message : "파일을 열 수 없습니다.");
    } finally {
      setBusyFileId(null);
    }
  }

  return (
    <section className="notice-files" aria-label="첨부파일">
      <h2 className="notice-files-title">첨부파일</h2>
      <ul className="notice-files-list">
        {files.map((file) => (
          <li key={file.id} className="notice-files-item">
            <div className="notice-files-meta">
              <span className="notice-files-name">{file.originalName}</span>
              <span className="notice-files-size">{formatNoticeFileSize(file.size)}</span>
            </div>
            <div className="notice-files-actions">
              {canInlineNoticeFile(file.mimeType) ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={busyFileId != null}
                  onClick={() => void run("open", file)}
                >
                  열기
                </button>
              ) : null}
              <button
                type="button"
                className={
                  canInlineNoticeFile(file.mimeType) ? "ui-btn ui-btn-ghost" : "ui-btn ui-btn-primary"
                }
                disabled={busyFileId != null}
                onClick={() => void run("download", file)}
              >
                {busyFileId === file.id ? "저장 중..." : "다운로드"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {note ? (
        <p
          className={noteOk ? "notice-files-note is-ok" : "notice-files-note"}
          role="status"
          aria-live="polite"
        >
          {note}
        </p>
      ) : null}
    </section>
  );
}
