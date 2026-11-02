"use client";

import { freeBoardPhotoSrc, type FreeBoardPhotoPublic } from "@/lib/freeBoardConstants";

/**
 * 가배치표 사진 보기 (가배치표 게시판 전용, 공용 코스제보/공지 갤러리는 변경 없음).
 * - 화면 폭 전체, object-fit: contain → 엑셀 캡처가 잘리지 않음
 * - 사진을 탭하면 원본을 새 탭으로 열어 브라우저 기본 확대(핀치 줌)로 볼 수 있음
 */
export default function FreeBoardPhotoGallery({
  postId,
  photos,
}: {
  postId: number;
  photos: FreeBoardPhotoPublic[];
}) {
  if (photos.length === 0) return null;
  return (
    <div className="free-board-sheets">
      <p className="free-board-sheets-hint">사진을 누르면 원본 크기로 열립니다. 두 손가락으로 확대해 보세요.</p>
      {photos.map((photo, index) => {
        const src = freeBoardPhotoSrc(postId, photo.id);
        return (
          <figure key={photo.id} className="free-board-sheet">
            <a
              href={src}
              target="_blank"
              rel="noopener"
              className="free-board-sheet-link"
              aria-label={`가배치표 사진 ${index + 1} 원본 크게 보기 (새 창)`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`가배치표 사진 ${index + 1}`}
                loading={index < 2 ? "eager" : "lazy"}
                decoding="async"
                className="free-board-sheet-img"
              />
            </a>
            <figcaption className="free-board-sheet-caption">
              사진 {index + 1}/{photos.length} ·{" "}
              <a href={src} target="_blank" rel="noopener">
                원본 보기
              </a>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
