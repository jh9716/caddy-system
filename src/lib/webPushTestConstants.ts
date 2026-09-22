/** Fixed 1-person test push copy. Safe for client + server. No VAPID, no web-push. */

export const TEST_PUSH_CONFIRM = "SEND_TEST_PUSH";
export const TEST_PUSH_TITLE = "VERTHILL 알림 테스트";
export const TEST_PUSH_BODY = "푸시 알림이 정상적으로 도착했습니다.";
export const TEST_PUSH_URL = "/caddy";

/** Server-owned native test copy. Client sends channel only. */
export const NATIVE_TEST_PUSH_TITLE = "VERTHILL";
export const NATIVE_TEST_PUSH_BODY = "네이티브 알림 테스트가 정상적으로 도착했습니다.";
export const NATIVE_TEST_PUSH_URL = "/";
export const NATIVE_TEST_PUSH_TAG = "native-fcm-e2e";
