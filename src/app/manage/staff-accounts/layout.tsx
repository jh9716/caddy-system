import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";

export const dynamic = "force-dynamic";

export default async function StaffAccountsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !isAccountManagerAuth(auth)) {
    return (
      <div className="card">
        <h1>접근 권한이 없습니다</h1>
        <p>직원 계정 관리는 최고관리자만 사용할 수 있습니다.</p>
      </div>
    );
  }
  return children;
}
