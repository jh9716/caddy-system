import { NOTICE_PUSH_CONFIRM } from "@/lib/noticeConstants";

export async function requestNoticePushSend(
  noticeId: number,
  post: typeof fetch = fetch
): Promise<{
  ok: boolean;
  message?: string;
  error?: string;
  sent?: number;
  failed?: number;
}> {
  const res = await post("/api/push/notice-send", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noticeId, confirm: NOTICE_PUSH_CONFIRM }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    sent?: number;
    failed?: number;
  };
  return {
    ok: res.ok,
    message: typeof data.message === "string" ? data.message : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    sent: data.sent,
    failed: data.failed,
  };
}
