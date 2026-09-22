import { prisma } from "@/lib/prisma";
import { resolvePushSubscriptionUserId } from "@/lib/adminPushUser";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { countEnabledAndroidDeviceTokens } from "@/lib/webPushTestSend";
import PushTestClient from "./PushTestClient";

export const dynamic = "force-dynamic";

export default async function ManagePushTestPage() {
  const auth = await getRequestAuthUser();
  const nativeUserId =
    auth && auth.role === "admin"
      ? await resolvePushSubscriptionUserId(prisma, {
          role: auth.role,
          userId: auth.userId,
          username: auth.username,
        })
      : null;
  const nativeTokenCount =
    nativeUserId != null ? await countEnabledAndroidDeviceTokens(prisma, nativeUserId) : 0;
  return <PushTestClient nativeTokenCount={nativeTokenCount} />;
}
