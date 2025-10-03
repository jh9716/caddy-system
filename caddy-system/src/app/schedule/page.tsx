// src/app/schedule/page.tsx
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic'; // 캐시 끄기

export default async function SchedulePage() {
  const items = await prisma.assignment.findMany({
    orderBy: [{ team: 'asc' }, { name: 'asc' }],
  });

  return (
    <section className="mx-auto max-w-3xl py-10">
      <h2 className="text-xl font-semibold mb-4">가용표</h2>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">아직 데이터가 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.id} className="rounded border p-3">
              <div>조: {m.team}조</div>
              <div>성명: {m.name}</div>
              <div>특이사항: {m.note ?? '-'}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
