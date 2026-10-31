/**
 * 자유게시판 V1 상수. 클라이언트/서버 공용 (비밀값 없음).
 * 경로는 /community (기존 /board = 확정 배치표, 덮어쓰지 않음).
 */
import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_MAX_BYTES,
  type CourseReportPhotoPublic,
} from "@/lib/courseReportPhotoConstants";

export const FREE_BOARD_PATH = "/community";
export const FREE_BOARD_LABEL = "자유게시판";
export const FREE_BOARD_TITLE_MAX = 100;
export const FREE_BOARD_BODY_MAX = 5000;
/** 게시글당 사진 최대 장수 (서버 강제). */
export const FREE_BOARD_PHOTO_MAX = 9;
export const FREE_BOARD_PHOTO_MAX_BYTES = COURSE_REPORT_PHOTO_MAX_BYTES;
export const FREE_BOARD_PHOTO_ACCEPT = COURSE_REPORT_PHOTO_ACCEPT;
export const FREE_BOARD_LIST_TAKE = 50;
/** 기존 notices/ , course-reports/ 와 분리된 전용 object storage prefix. */
export const FREE_BOARD_STORAGE_PREFIX = "free-board";
/**
 * Feature flag. 기본 OFF → Production 에서는 메뉴/화면/API 모두 숨김(404).
 * NEXT_PUBLIC_ 이라 클라이언트 번들에 빌드 시점 값이 들어간다 (비밀값 아님).
 */
export const FREE_BOARD_FLAG_ENV = "NEXT_PUBLIC_FREE_BOARD_ENABLED";

export function isFreeBoardEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED === "1";
}

export type FreeBoardPhotoPublic = CourseReportPhotoPublic;

export type FreeBoardPostPublic = {
  id: number;
  title: string;
  body: string;
  authorUserId: number;
  authorDisplayName: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  photoCount: number;
  commentCount?: number;
  canEdit: boolean;
  canDelete: boolean;
};

export function freeBoardPhotoSrc(postId: number, photoId: number): string {
  return `/api/free-board/${postId}/photos/${photoId}`;
}
