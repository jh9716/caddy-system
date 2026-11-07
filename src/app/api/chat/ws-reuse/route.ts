import { NextResponse } from "next/server";
import { currentChatAppEnv } from "@/lib/chatAppEnv";
import {
  CHAT_WS_REUSE_RUNTIME_ENV,
  CHAT_WS_REUSE_RUNTIME_RESPONSE_HEADERS,
  PRODUCTION_CHAT_WS_REUSE_ENABLED,
  resolveChatWsReuseRuntime,
} from "@/lib/chatWsReuse";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

/**
 * Park-enabled probe for open tabs. No DB.
 * After Instant Rollback to an OFF deploy this returns enabled:false (or 404
 * on older builds). Changing CHAT_WS_REUSE_RUNTIME on an existing Vercel
 * deployment does not take effect.
 */
export async function GET() {
  const enabled = resolveChatWsReuseRuntime({
    compileEnabled: PRODUCTION_CHAT_WS_REUSE_ENABLED === true,
    appEnv: currentChatAppEnv(),
    runtime: process.env[CHAT_WS_REUSE_RUNTIME_ENV],
  });
  return NextResponse.json({ enabled }, { headers: CHAT_WS_REUSE_RUNTIME_RESPONSE_HEADERS });
}
