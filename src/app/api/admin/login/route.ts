import { NextRequest } from "next/server";
import { postAdminEnvPasswordLogin } from "@/lib/adminEnvPasswordLogin";

export async function POST(req: NextRequest) {
  return postAdminEnvPasswordLogin(req);
}
