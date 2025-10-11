// app/dashboard/page.tsx
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">대시보드 OK</h1>
      <p className="text-gray-600 mt-2">빌드 반영 테스트</p>
    </div>
  );
}
