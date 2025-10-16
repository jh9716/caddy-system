// src/app/manage/DashboardClient.tsx
'use client';
import { useEffect, useState } from 'react';

type Summary = {
  date: string
  totalCaddies: number
  today: { off: number; sick: number; longSick: number; duty: number; marshal: number }
  latestNotices: { id: number; title: string; createdAt: string }[]
};

export default function DashboardClient() {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch('/api/summary', { credentials: 'include' });
        const data: Summary = await res.json();
        setSummary(data);
      } catch {
        alert('요약 정보를 불러오지 못했습니다.');
      } finally {
        setLoading(false);
      }
    };
    run();
  }, []);

  if (loading) return <p style={{ textAlign: 'center', marginTop: 100 }}>로딩 중...</p>;

  return (
    <div style={{ maxWidth: 1100, margin: '20px auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>관리자 대시보드</h2>
      {summary && (
        <>
          <p style={{ marginBottom: 14, color: '#64748b' }}>{summary.date} 요약</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
            <Card title="총 캐디" value={summary.totalCaddies} />
            <Card title="휴무" value={summary.today.off} />
            <Card title="병가" value={summary.today.sick} />
            <Card title="장기병가" value={summary.today.longSick} />
            <Card title="당번" value={summary.today.duty} />
            <Card title="마샬" value={summary.today.marshal} />
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>최근 공지</h3>
            <ul style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {summary.latestNotices.length === 0 && (
                <li style={{ padding: 12, color: '#64748b' }}>공지 없음</li>
              )}
              {summary.latestNotices.map(n => (
                <li key={n.id} style={{ padding: 12, borderTop: '1px solid #f1f5f9' }}>
                  <a href={`/notice/${n.id}`} style={{ textDecoration: 'none', color: '#0f172a' }}>
                    {n.title}
                  </a>
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8' }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Card({ title, value }: { title: string; value: number }) {
  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 12, padding: 12,
      background: '#fff', minHeight: 80
    }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
    </div>
  );
}
