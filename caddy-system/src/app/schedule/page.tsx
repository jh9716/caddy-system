
'use client';

import { useState } from 'react';
import Badge from '@/components/Badge';

type Status =
  | '가용'
  | '휴무'
  | '병가'
  | '54홀'
  | '첫대기'
  | '당번'
  | '마샬'
  | 'VIP'
  | '찾근'
  | '1.3찾근'
  | '경조사'
  | '외국어';

type Caddy = {
  카드: number | string;
  성명: string;
  특이사항?: Status[];
};

type Team = {
  조: number;
  인원: Caddy[];
};

const COLOR: Record<Status, string> = {
  가용: '#e5f6ff',
  휴무: '#d1fae5',
  병가: '#fef08a',
  '54홀': '#fde68a',
  첫대기: '#e9d5ff',
  당번: '#fee2e2',
  마샬: '#e0e7ff',
  VIP: '#ffedd5',
  찾근: '#fbcfe8',
  '1.3찾근': '#f5d0fe',
  경조사: '#dcfce7',
  외국어: '#cffafe',
};

// 샘플 데이터 (나중에 DB 연동 예정)
const SAMPLE: Team[] = [
  {
    조: 1,
    인원: [
      { 카드: 12, 성명: '이영진', 특이사항: ['휴무'] },
      { 카드: 34, 성명: '박서진2', 특이사항: [] }, // 빈칸 = 가용
      { 카드: 16, 성명: '간동민', 특이사항: ['54홀'] },
      { 카드: 29, 성명: '강정미', 특이사항: ['휴무'] },
    ],
  },
  {
    조: 3,
    인원: [
      { 카드: 39, 성명: '김지희', 특이사항: [] },
      { 카드: 60, 성명: '울민재', 특이사항: ['휴무'] },
      { 카드: 68, 성명: '김하라', 특이사항: ['첫대기'] },
    ],
  },
  {
    조: 5,
    인원: [
      { 카드: 88, 성명: '김지현', 특이사항: ['1.3찾근'] },
      { 카드: 92, 성명: '이슬', 특이사항: ['병가'] },
      { 카드: 95, 성명: '장수진', 특이사항: ['당번'] },
    ],
  },
];

export default function SchedulePage() {
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [teams] = useState<Team[]>(SAMPLE);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 12 }}>가용표</h1>

      {/* 상단 컨트롤 */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <label style={{ fontSize: 14, color: '#475569' }}>
          날짜:{' '}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: '6px 10px',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
            }}
          />
        </label>

        <div style={{ fontSize: 12, color: '#64748b' }}>
          • 빈칸 = 가용 • 색상 배지는 특이사항만 표시
        </div>
      </div>

      {/* 조별 표 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 16,
        }}
      >
        {teams.map((team) => (
          <section
            key={team.조}
            style={{
              background: '#ffffff',
              border: '1px solid #e5e7eb',
              borderRadius: 16,
              overflow: 'hidden',
              boxShadow: '0 1px 2px rgba(0,0,0,.04)',
            }}
          >
            <header
              style={{
                padding: '10px 14px',
                background: '#f8fafc',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontWeight: 700,
              }}
            >
              <span>{team.조}조</span>
              <span style={{ color: '#64748b', fontWeight: 500 }}>
                총 {team.인원.length}명
              </span>
            </header>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fcfcfc' }}>
                  <th style={th}>카드</th>
                  <th style={th}>성명</th>
                  <th style={th}>특이사항</th>
                </tr>
              </thead>
              <tbody>
                {team.인원.map((c, idx) => {
                  const has = c.특이사항 && c.특이사항.length > 0;
                  return (
                    <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>{c.카드}</td>
                      <td style={td}>{c.성명}</td>
                      <td style={td}>
                        {has ? (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {c.특이사항!.map((s) => (
                              <Badge key={s} text={s} color={COLOR[s]} />
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8' }}>가용</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
      </div>

      {/* 범례 */}
      <details style={{ marginTop: 20 }}>
        <summary style={{ cursor: 'pointer', color: '#475569' }}>범례 보기</summary>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          {(Object.keys(COLOR) as Status[]).map((k) => (
            <Badge key={k} text={k} color={COLOR[k]} />
          ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>
          * 첫대기: 3조 첫번째부터 아래로, 다음은 4조 위에서 아래로 순번 적용(규칙 편집은 관리자 메뉴에서 추가 예정)
        </div>
      </details>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 12,
  color: '#64748b',
  borderBottom: '1px solid #e5e7eb',
};

const td: React.CSSProperties = {
  padding: '12px',
  fontSize: 14,
};
