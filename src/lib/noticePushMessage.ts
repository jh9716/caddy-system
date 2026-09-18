import {
  NOTICE_PUSH_IMPORTANT_TITLE,
  NOTICE_PUSH_TITLE,
} from "@/lib/noticeConstants";

export function noticePushUrl(noticeId: number): string {
  return `/notice/${noticeId}`;
}

export function buildNoticePushPayload(input: {
  noticeId: number;
  title: string;
  important: boolean;
}): {
  title: string;
  body: string;
  url: string;
  tag: string;
} {
  const id = Number(input.noticeId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("noticeId가 올바르지 않습니다.");
  }
  return {
    title: input.important ? NOTICE_PUSH_IMPORTANT_TITLE : NOTICE_PUSH_TITLE,
    body: String(input.title ?? ""),
    url: noticePushUrl(id),
    tag: `notice-${id}`,
  };
}
