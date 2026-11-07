import { NextResponse } from "next/server";
import { currentChatAppEnv } from "@/lib/chatAppEnv";
import {
  CHAT_WS_REUSE_RUNTIME_ENV,
  PRODUCTION_CHAT_WS_REUSE_ENABLED,
  resolveChatWsReuseRuntime,
} from "@/lib/chatWsReuse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runtime park kill switch. No DB. Compile const must already be true.
 * After ON deploy, CHAT_WS_REUSE_RUNTIME=0 turns park off without a rebuild.
 */
export async function GET() {
  const enabled = resolveChatWsReuseRuntime({
    compileEnabled: PRODUCTION_CHAT_WS_REUSE_ENABLED === true,
    appEnv: currentChatAppEnv(),
    runtime: process.env[CHAT_WS_REUSE_RUNTIME_ENV],
  });
  return NextResponse.json(
    { enabled },
    {
      headers: {
        "cache-control": "no-store",
      },
    }
  );
}
