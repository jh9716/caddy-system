import { communityPhotoSrc, type CommunityPhotoPublic } from "@/lib/communityBoardConstants";

/** 자유게시판 사진: 세로로 큰 이미지, 누르면 원본을 새 탭으로 (핀치 확대). */
export default function TalkPhotoGallery({ postId, photos }: { postId: number; photos: CommunityPhotoPublic[] }) {
  if (photos.length === 0) return null;
  return (
    <div className="talk-photos">
      {photos.map((photo, index) => {
        const src = communityPhotoSrc(postId, photo.id);
        return (
          <a
            key={photo.id}
            href={src}
            target="_blank"
            rel="noopener"
            className="talk-photo"
            aria-label={`사진 ${index + 1} 크게 보기 (새 창)`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`첨부 사진 ${index + 1}`} loading={index < 2 ? "eager" : "lazy"} decoding="async" />
          </a>
        );
      })}
    </div>
  );
}
