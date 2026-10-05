import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { ChatAuthError, issueChatAccessToken } from "@/lib/chatAuth";
import { chatNotifyPrefMap } from "@/lib/chatNotificationPref";
import { prisma } from "@/lib/prisma";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await resolveAuthUser(req);
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (shouldForcePasswordChange(auth)) return mustChangePasswordResponse();
    const issued = await issueChatAccessToken(prisma, auth);
    const rows = await prisma.chatRoomNotificationPreference.findMany({
      where: { userId: issued.user.userId },
      select: { roomId: true, mode: true },
    });
    return NextResponse.json({ ok: true, prefs: chatNotifyPrefMap(rows) });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    if (e instanceof ChatAuthError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "";
    if (/ChatRoomNotificationPreference/i.test(msg)) {
      return NextResponse.json({ ok: true, prefs: {} });
    }
    console.error("[GET /api/chat/notification-prefs]", e);
    return NextResponse.json({ error: "prefs_failed" }, { status: 500 });
  }
}
