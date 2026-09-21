export const NATIVE_PUSH_TOKEN_PATH = "/api/push/native-token";

export function nativeTokenRequestInit(
  token: string
): {
  method: "POST";
  headers: { "Content-Type": "application/json" };
  credentials: "include";
  body: string;
} {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token, platform: "ANDROID" }),
  };
}

export function nativeTokenStatusHeaders(token: string): HeadersInit {
  return { "x-native-push-token": token };
}

export function nativeTokenDisableInit(
  token: string | null,
  scope: "current" | "all" = "current"
): {
  method: "DELETE";
  headers: { "Content-Type": "application/json" };
  credentials: "include";
  body: string;
} {
  const body =
    scope === "all" ? { scope: "all" } : { token: String(token ?? "") };
  return {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  };
}
