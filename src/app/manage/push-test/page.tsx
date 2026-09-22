import { prisma } from "@/lib/prisma";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { countEnabledAndroidDeviceTokens } from "@/lib/webPushTestSend";
import PushTestClient from "./PushTestClient";

export const dynamic = "force-dynamic";

export default async function ManagePushTestPage() {
  const auth = await getRequestAuthUser();
  const nativeTokenCount =
    auth?.role === "admin" && typeof auth.userId === "number"
      ? await countEnabledAndroidDeviceTokens(prisma, auth.userId)
      : 0;
  return <PushTestClient nativeTokenCount={nativeTokenCount} />;
}
