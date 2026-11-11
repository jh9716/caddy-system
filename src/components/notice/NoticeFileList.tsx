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
  if (files.length === 0) return null;

  async function run(
    action: "open" | "download",
    file: NoticeFilePublic
  ) {
    setNote("");
    try {
      if (action === "download") {
        await downloadNoticeFile({
          noticeId,
          fileId: file.id,
          originalName: file.originalName,
          mimeType: file.mimeType,
        });
        return;
      }
      await openNoticeFile({
        noticeId,
        fileId: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        native: readCapacitorNativePlatform(),
      });
    } catch (e) {
      setNote(e instanceof Error ? e.message : "파일을 열 수 없습니다.");
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
                onClick={() => void run("download", file)}
              >
                다운로드
              </button>
            </div>
          </li>
        ))}
      </ul>
      {note ? <p className="notice-files-note">{note}</p> : null}
    </section>
  );
}
