import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  resolveAuthUser,
} from "@/lib/auth";
import { clearSessionCookies } from "@/lib/sessionCookies";
import {
  isEnvOnlyNonAdmin,
  resolvePushSubscriptionUserId,
} from "@/lib/adminPushUser";
import {
  NativePushTokenError,
  disableAllDevicePushTokensForUser,
  disableDevicePushToken,
  isDevicePushStoreMissing,
  parseNativePushPlatform,
  parseNativePushToken,
  upsertDevicePushToken,
  userHasEnabledDevicePushToken,
} from "@/lib/nativePushToken";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StatusBody = {
  configured: boolean;
  registered: boolean;
  enabled: boolean;
};

function statusJson(extra: Partial<StatusBody> = {}): StatusBody {
  const registered = extra.registered === true;
  return {
    configured: extra.configured !== false,
    registered,
    enabled: extra.enabled === true || registered,
  };
}

function logRoute(op: string, e: unknown) {
  const code =
    e && typeof e === "object" && "code" in e
      ? String((e as { code?: unknown }).code ?? "")
      : "";
  console.error(`[ /api/push/native-token ${op} ]`, code || "failed");
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

function readTokenHeader(req: NextRequest): string | null {
  const raw = req.headers.get("x-native-push-token");
  if (!raw) return null;
  try {
    return parseNativePushToken(raw);
  } catch {
    return null;
  }
}

/** GET — whether this User+this device token is registered. Never echoes the token. */
export async function GET(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;
  try {
    const token = readTokenHeader(req);
    const exists =
      token != null
        ? await userHasEnabledDevicePushToken(prisma, {
            userId: gate.userId,
            token,
          })
        : false;
    return NextResponse.json(
      statusJson({ configured: true, registered: exists, enabled: exists })
    );
  } catch (e) {
    if (isDevicePushStoreMissing(e)) {
      return NextResponse.json(
        statusJson({ configured: true, registered: false, enabled: false })
      );
    }
    logRoute("GET", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** POST — upsert this device token onto the current User. Client userId ignored. */
export async function POST(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;
  const body = await req.json().catch(() => ({}));
  try {
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (rec.userId != null) {
      throw new NativePushTokenError(
        "client_user_id_not_trusted",
        "userId는 서버가 결정합니다.",
        400
      );
    }
    const token = parseNativePushToken(rec.token);
    const platform = parseNativePushPlatform(rec.platform);
    await upsertDevicePushToken(prisma, {
      userId: gate.userId,
      token,
      platform,
    });
    return NextResponse.json(
      statusJson({ configured: true, registered: true, enabled: true })
    );
  } catch (e) {
    if (e instanceof NativePushTokenError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (isDevicePushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    logRoute("POST", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * DELETE — disable this device token, or all tokens for the user when scope=all.
 * Logout-all uses scope=all. Single logout disables the current token only.
 */
export async function DELETE(req: NextRequest) {
  const gate = await requireDbPushUser(req);
  if (gate.error) return gate.error;
  const body = await req.json().catch(() => ({}));
  try {
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (rec.scope === "all") {
      await disableAllDevicePushTokensForUser(prisma, gate.userId);
      return NextResponse.json(
        statusJson({ configured: true, registered: false, enabled: false })
      );
    }
    const token = parseNativePushToken(rec.token);
    await disableDevicePushToken(prisma, { userId: gate.userId, token });
    return NextResponse.json(
      statusJson({ configured: true, registered: false, enabled: false })
    );
  } catch (e) {
    if (e instanceof NativePushTokenError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    if (isDevicePushStoreMissing(e)) {
      return NextResponse.json({ error: "push_store_unavailable" }, { status: 503 });
    }
    logRoute("DELETE", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
