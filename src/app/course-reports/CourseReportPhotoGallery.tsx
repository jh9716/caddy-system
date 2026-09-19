"use client";

import { useState } from "react";
import type { CourseReportPhotoPublic } from "@/lib/courseReportPhotoConstants";
import { courseReportPhotoSrc } from "@/lib/courseReportPhotoConstants";

export default function CourseReportPhotoGallery({
  reportId,
  photos,
}: {
  reportId: number;
  photos: CourseReportPhotoPublic[];
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (photos.length === 0) return null;
  const open = photos.find((p) => p.id === openId) ?? null;

  return (
    <div className="course-report-photos">
      <div
        className={`course-report-photo-grid is-${Math.min(photos.length, 3)}`}
      >
        {photos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            className="course-report-photo-thumb"
            onClick={() => setOpenId(photo.id)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={courseReportPhotoSrc(reportId, photo.id)}
              alt=""
            />
          </button>
        ))}
      </div>
      {open ? (
        <button
          type="button"
          className="course-report-photo-lightbox"
          onClick={() => setOpenId(null)}
          aria-label="닫기"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={courseReportPhotoSrc(reportId, open.id)} alt="" />
        </button>
      ) : null}
    </div>
  );
}
