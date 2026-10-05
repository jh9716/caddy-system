import { redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import OffRequestTeamClient from "./OffRequestTeamClient";

export const dynamic = "force-dynamic";

export default async function OffRequestTeamPage() {
  const auth = await getRequestAuthUser();
  if (!auth || auth.role !== "leader") {
    redirect("/off-requests");
  }
  return <OffRequestTeamClient />;
}
