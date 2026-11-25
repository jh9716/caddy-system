"use client";

import { useState } from "react";
import PhotoZoomViewer from "@/components/photo/PhotoZoomViewer";
import { freeBoardPhotoSrc, type FreeBoardPhotoPublic } from "@/lib/freeBoardConstants";

/**
 * 가배치표 사진 보기 (가배치표 게시판 전용, 공용 코스제보/공지 갤러리는 변경 없음).
 * - 화면 폭 전체, object-fit: contain → 엑셀 캡처가 잘리지 않음
 * - 사진을 탭하면 현재 화면 위 확대 뷰어(두 손가락 확대·이동·두 번 탭)로 열림
 * - '원본 보기' 링크를 직접 누를 때만 기존처럼 원본을 새 창으로 엶
 */
export default function FreeBoardPhotoGallery({
  postId,
  photos,
}: {
  postId: number;
  photos: FreeBoardPhotoPublic[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (photos.length === 0) return null;
  const open = photos.find((p) => p.id === openId) ?? null;
  return (
    <div className="free-board-sheets">
      <p className="free-board-sheets-hint">사진을 누르면 크게 열립니다. 두 손가락으로 확대해 보세요.</p>
      {photos.map((photo, index) => {
        const src = freeBoardPhotoSrc(postId, photo.id);
        return (
          <figure key={photo.id} className="free-board-sheet">
            <button
              type="button"
              className="free-board-sheet-link"
              onClick={() => setOpenId(photo.id)}
              aria-label={`가배치표 사진 ${index + 1} 크게 보기`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`가배치표 사진 ${index + 1}`}
                loading={index < 2 ? "eager" : "lazy"}
                decoding="async"
                className="free-board-sheet-img"
              />
            </button>
            <figcaption className="free-board-sheet-caption">
              사진 {index + 1}/{photos.length} ·{" "}
              <a href={src} target="_blank" rel="noopener">
                원본 보기
              </a>
            </figcaption>
          </figure>
        );
      })}
      {open ? (
        <PhotoZoomViewer
          src={freeBoardPhotoSrc(postId, open.id)}
          alt="가배치표 사진"
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
