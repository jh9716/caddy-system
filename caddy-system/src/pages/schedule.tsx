import { GetServerSideProps } from 'next';
import { statusLabels, teamLabels } from '../utils/statusLabels';

type Assignment = {
  id: number;
  caddyName: string;
  team: keyof typeof teamLabels;
  status: keyof typeof statusLabels;
  notes?: string | null;
};

type Props = { items: Assignment[] };

export default function SchedulePage({ items }: Props) {
  // 팀별로 그룹핑
  const byTeam: Record<string, Assignment[]> = {};
  for (const a of items) {
    const key = a.team;
    (byTeam[key] ||= []).push(a);
  }

  const teamOrder = ['TEAM_1','TEAM_2','TEAM_3','TEAM_4','TEAM_5','TEAM_6','TEAM_7','TEAM_8'];

  return (
    <div style={{ padding: 24 }}>
      <h1>가용표</h1>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap: 16 }}>
        {teamOrder.map(t => (
          <div key={t} style={{ border:'1px solid #eee', borderRadius:12, padding:12 }}>
            <h3>{teamLabels[t]}</h3>
            <table width="100%">
              <thead>
                <tr>
                  <th align="left">성명</th>
                  <th align="left">상태</th>
                  <th align="left">특이사항</th>
                </tr>
              </thead>
              <tbody>
                {(byTeam[t] || []).map(row => (
                  <tr key={row.id}>
                    <td>{row.caddyName}</td>
                    <td>{statusLabels[row.status]}</td>
                    <td>{row.notes || ''}</td>
                  </tr>
                ))}
                {/* 빈 칸 채우기: 가용 인원 칸 확보 */}
                {Array.from({ length: Math.max(0, 8 - (byTeam[t]?.length || 0)) }).map((_, i) => (
                  <tr key={`empty-${i}`}><td colSpan={3} style={{ height: 24, color:'#bbb' }}> </td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

// 서버에서 데이터 가져오기 (SSR)
export const getServerSideProps: GetServerSideProps<Props> = async ({ req }) => {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : `http://localhost:3000`; // 로컬 개발 시

  const resp = await fetch(`${base}/api/assignments`);
  const items = await resp.json();

  return { props: { items } };
};
