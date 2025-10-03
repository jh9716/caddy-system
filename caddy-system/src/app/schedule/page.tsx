// 서버 컴포넌트
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic'; // 초기엔 캐시끈다(변화 바로보기)

export default async function SchedulePage() {
  // 실제 모델/필드명으로 맞추세요.
  const items = await prisma.assignment.findMany({
    orderBy: [{ 조: 'asc' }, { 성함: 'asc' }],
  });

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontWeight: 600, marginBottom: 12 }}>가용표</h1>
      <table style={{ minWidth: 600, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>조</th>
            <th style={th}>성함</th>
            <th style={th}>특이사항</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td style={td}>{m.조}</td>
              <td style={td}>{m.성함}</td>
              <td style={td}>{m.특이사항 ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { border: '1px solid #ccc', padding: 6, background: '#f7f7f7', textAlign: 'left' };
const td: React.CSSProperties = { border: '1px solid #ccc', padding: 6 };
