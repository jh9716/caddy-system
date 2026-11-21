/**
 * 커뮤니티 자유게시판 V1 상수. 클라이언트/서버 공용 (비밀값 없음).
 *
 * - 화면 경로 /talk, API /api/talk (기존 가배치표 /community · /api/free-board 와 완전히 분리)
 * - DB: CommunityPost / CommunityPhoto (boardType=FREE). 기존 FreeBoardPost 는 가배치표 전용으로 그대로.
 * - 사진 key prefix: community/free/<postId>/<uuid>.<ext> (가배치표 free-board/ 와 분리)
 */
import {
  FREE_BOARD_PHOTO_ACCEPT,
  FREE_BOARD_PHOTO_MAX_BYTES,
  isFreeBoardEnabled,
  type FreeBoardPhotoPublic,
} from "@/lib/freeBoardConstants";

export const COMMUNITY_FREE_BOARD_LABEL = "자유게시판";
export const COMMUNITY_FREE_BOARD_PATH = "/talk";
export const COMMUNITY_FREE_BOARD_API = "/api/talk";
export const COMMUNITY_TITLE_MAX = 100;
export const COMMUNITY_BODY_MAX = 5000;
/** 게시글당 사진 최대 장수 (서버 강제). */
export const COMMUNITY_PHOTO_MAX = 9;
/** 장당 용량 (서버 강제, 가배치표와 같은 3MB). */
export const COMMUNITY_PHOTO_MAX_BYTES = FREE_BOARD_PHOTO_MAX_BYTES;
export const COMMUNITY_PHOTO_ACCEPT = FREE_BOARD_PHOTO_ACCEPT;
/** 목록 한 페이지 글 수. */
export const COMMUNITY_PAGE_SIZE = 20;
/** 검색어 최대 길이. */
export const COMMUNITY_SEARCH_MAX = 50;
/** 전용 object storage prefix (게시판 종류별 하위 폴더). */
export const COMMUNITY_STORAGE_PREFIX = "community/free";

/**
 * 노출 조건: 기존 커뮤니티 기능 플래그(NEXT_PUBLIC_FREE_BOARD_ENABLED=1)를 그대로 따른다.
 * 새 환경변수 추가 없이 끌 수 있도록 NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED=1 이면 숨김(kill switch).
 */
export function isCommunityFreeBoardEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED === "1") return false;
  return isFreeBoardEnabled();
}

export type CommunityPhotoPublic = FreeBoardPhotoPublic;

export type CommunityPostPublic = {
  id: number;
  title: string;
  body: string;
  authorUserId: number;
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  photoCount: number;
  commentCount: number;
  isMine: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

/** 목록 행: 본문 전체 대신 상세 이동에 필요한 값만. */
export type CommunityPostListItem = Omit<CommunityPostPublic, "body">;

export type CommunityListPage = {
  posts: CommunityPostListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  q: string;
};

export function communityPhotoSrc(postId: number, photoId: number): string {
  return `${COMMUNITY_FREE_BOARD_API}/${postId}/photos/${photoId}`;
}

export function communityPostHref(postId: number): string {
  return `${COMMUNITY_FREE_BOARD_PATH}/${postId}`;
}

/** 목록 URL (검색어·페이지 유지). */
export function communityListHref(input: { q?: string; page?: number } = {}): string {
  const sp = new URLSearchParams();
  const q = (input.q ?? "").trim();
  if (q) sp.set("q", q);
  if (input.page && input.page > 1) sp.set("page", String(input.page));
  const qs = sp.toString();
  return qs ? `${COMMUNITY_FREE_BOARD_PATH}?${qs}` : COMMUNITY_FREE_BOARD_PATH;
}
