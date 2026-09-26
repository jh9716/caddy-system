"use client";

import { useState } from "react";
import type { NoticePhotoPublic } from "@/lib/noticePhotoConstants";
import { noticePhotoSrc } from "@/lib/noticePhotoConstants";

export default function NoticePhotoGallery({
  noticeId,
  photos,
}: {
  noticeId: number;
  photos: NoticePhotoPublic[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (photos.length === 0) return null;
  const open = photos.find((p) => p.id === openId) ?? null;

  return (
    <div className="notice-photos">
      <div className="notice-photos-list">
        {photos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            className="notice-photos-item"
            onClick={() => setOpenId(photo.id)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={noticePhotoSrc(noticeId, photo.id)} alt="" />
          </button>
        ))}
      </div>
      {open ? (
        <button
          type="button"
          className="notice-photos-lightbox"
          onClick={() => setOpenId(null)}
          aria-label="닫기"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={noticePhotoSrc(noticeId, open.id)} alt="" />
        </button>
      ) : null}
    </div>
  );
}
