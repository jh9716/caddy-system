"use client";

import { useState } from "react";
import PhotoZoomViewer from "@/components/photo/PhotoZoomViewer";
import { communityPhotoSrc, type CommunityPhotoPublic } from "@/lib/communityBoardConstants";

/**
 * 자유게시판 사진: 세로로 큰 이미지.
 * 누르면 현재 화면 위 확대 뷰어로 열림 (두 손가락 확대·이동·두 번 탭).
 * 원본을 새 창으로 보는 기존 방식은 '원본 보기' 링크로만 남김.
 */
export default function TalkPhotoGallery({ postId, photos }: { postId: number; photos: CommunityPhotoPublic[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (photos.length === 0) return null;
  const open = photos.find((p) => p.id === openId) ?? null;
  return (
    <div className="talk-photos">
      {photos.map((photo, index) => {
        const src = communityPhotoSrc(postId, photo.id);
        return (
          <figure key={photo.id} className="talk-photo-item">
            <button
              type="button"
              className="talk-photo"
              onClick={() => setOpenId(photo.id)}
              aria-label={`사진 ${index + 1} 크게 보기`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`첨부 사진 ${index + 1}`} loading={index < 2 ? "eager" : "lazy"} decoding="async" />
            </button>
            <figcaption className="talk-photo-caption">
              <a href={src} target="_blank" rel="noopener">
                원본 보기
              </a>
            </figcaption>
          </figure>
        );
      })}
      {open ? (
        <PhotoZoomViewer
          src={communityPhotoSrc(postId, open.id)}
          alt="자유게시판 사진"
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
