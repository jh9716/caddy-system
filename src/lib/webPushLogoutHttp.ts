export const PUSH_SUBSCRIPTION_PATH = "/api/push/subscription";

export function webPushLogoutDisableInit(
  endpoint: string | null,
  scope: "current" | "all" = "current"
): {
  method: "DELETE";
  headers: { "Content-Type": "application/json" };
  credentials: "include";
  body: string;
} {
  const body =
    scope === "all"
      ? { scope: "all" }
      : { endpoint: String(endpoint ?? ""), scope: "current" };
  return {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  };
}
