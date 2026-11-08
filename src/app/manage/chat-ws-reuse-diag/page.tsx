import { redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import ChatWsReuseDiagClient from "./ChatWsReuseDiagClient";

export const dynamic = "force-dynamic";

export default async function ManageChatWsReuseDiagPage() {
  const auth = await getRequestAuthUser();
  if (!auth || auth.role !== "admin") {
    redirect("/login?callbackUrl=/manage/chat-ws-reuse-diag");
  }
  return <ChatWsReuseDiagClient adminAllowed />;
}
