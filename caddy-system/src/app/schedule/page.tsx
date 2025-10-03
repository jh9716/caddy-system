// src/app/schedule/page.tsx
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic'; // 캐시 방지(초기엔 편해요)

export default async function SchedulePage() {
  const items = await prisma.assignment.findMany({
    orderBy: [{ 조: 'asc' }, { 성함: 'asc' }],
  });

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">가용표</h1>
      <table className="min-w-[640px] border">
        <thead>
          <tr>
            <th className="border px-2 py-1">조</th>
            <th className="border px-2 py-1">성함</th>
            <th className="border px-2 py-1">직무</th>
            <th className="border px-2 py-1">투입가능일</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td className="border px-2 py-1">{m.조}</td>
              <td className="border px-2 py-1">{m.성함}</td>
              <td className="border px-2 py-1">{m.직무}</td>
              <td className="border px-2 py-1">{m.투입가능일 ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
