import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  resolveAuthUser,
} from "@/lib/auth";
import { clearSessionCookies } from "@/lib/sessionCookies";
import { isWebPushConfigured, vapidClientConfig } from "@/lib/pushVapid";
import {
  isEnvOnlyNonAdmin,
  resolvePushSubscriptionUserId,
} from "@/lib/adminPushUser";
import {
  PushSubscriptionError,
  deletePushSubscriptionForUser,
  isPushStoreMissing,
  parsePushSubscriptionInput,
  upsertPushSubscriptionForUser,
  userHasEnabledPushSubscriptionForEndpoint,
  validatePushEndpoint,
  PUSH_ENDPOINT_HEADER,
} from "@/lib/pushSubscriptionStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StatusBody = {
  configured: boolean;
  vapidPublicKey: string | null;
  subscriptionExists: boolean;
  enabled: boolean;
};

function statusJson(
  extra: Partial<StatusBody> & Pick<StatusBody, "configured" | "vapidPublicKey">
): StatusBody {
  const subscriptionExists = extra.subscriptionExists === true;
  return {
    configured: extra.configured,
    vapidPublicKey: extra.vapidPublicKey,
    subscriptionExists,
    enabled: extra.enabled === true || subscriptionExists,
  };
}

function logRoute(op: string, e: unknown) {
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code ?? "")
      : "";
  console.error(`[ /api/push/subscription ${op} ]`, code || "failed");
}

async function requireDbPushUser(req: NextRequest) {
  let auth;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) {
      return { error: authUnavailableResponse() };
    }
    throw e;
  }
  if (!auth) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    clearSessionCookies(res, req);
    return { error: res };
  }
  const userId = await resolvePushSubscriptionUserId(prisma, auth);
  if (userId == null) {
    if (isEnvOnlyNonAdmin(auth)) {
      return {
        error: NextResponse.json(
          {
            error: "unsupported",
            message: "환경변수 계정은 알림을 등록할 수 없습니다.",
          },
          { status: 400 }
        ),
      };
    }
    return {
      error: NextResponse.json(
        {
          error: "forbidden",
          message: "관리자 계정을 찾을 수 없습니다.",
        },
        { status: 403 }
      ),
    };
  }
  return { auth, userId };
}

function readPushEndpointHeader(req: NextRequest): string | null {
  const raw = req.headers.get(PUSH_ENDPOINT_HEADER);
  if (!raw) return null;
  try {
    return validatePushEndpoint(raw);
  } catch {
    return null;
  }
}

/** GET — public VAPID + whether this User+this browser endpoint is registered. No endpoint/keys. */
export async function GET(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;

  const cfg = vapidClientConfig();
  if (!cfg.configured) {
    return NextResponse.json(
      statusJson({ configured: false, vapidPublicKey: null, subscriptionExists: false, enabled: false })
    );
  }

  try {
    const endpoint = readPushEndpointHeader(req);
    const exists =
      endpoint != null
        ? await userHasEnabledPushSubscriptionForEndpoint(prisma, gate.userId, endpoint)
        : false;
    return NextResponse.json(
      statusJson({
        configured: true,
        vapidPublicKey: cfg.vapidPublicKey,
        subscriptionExists: exists,
        enabled: exists,
      })
    );
  } catch (e) {
    if (isPushStoreMissing(e)) {
      return NextResponse.json(
        statusJson({
          configured: true,
          vapidPublicKey: cfg.vapidPublicKey,
          subscriptionExists: false,
          enabled: false,
        })
      );
    }
    logRoute("GET", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** POST — upsert this device onto the current User. Ignores client userId. */
export async function POST(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;
  if (!isWebPushConfigured()) {
    return NextResponse.json(
      { error: "not_configured", message: "알림 설정 준비 중" },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));

  try {
    const input = parsePushSubscriptionInput(body);
    await upsertPushSubscriptionForUser(prisma, gate.userId, input);
    return NextResponse.json(
      statusJson({
        configured: true,
        vapidPublicKey: null,
        subscriptionExists: true,
        enabled: true,
      })
    );
  } catch (e) {
    if (e instanceof PushSubscriptionError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (isPushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    logRoute("POST", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DELETE — device-level: owner check, then all mappings for this endpoint. Logout does not call this. */
export async function DELETE(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;

  const body = await req.json().catch(() => ({}));
  try {
    const endpoint = validatePushEndpoint(
      body && typeof body === "object"
        ? (body as { endpoint?: unknown }).endpoint
        : ""
    );
    await deletePushSubscriptionForUser(prisma, gate.userId, endpoint);
    return NextResponse.json(
      statusJson({
        configured: isWebPushConfigured(),
        vapidPublicKey: null,
        subscriptionExists: false,
        enabled: false,
      })
    );
  } catch (e) {
    if (e instanceof PushSubscriptionError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (isPushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    logRoute("DELETE", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
