'use client';

import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';

type Caddy = {
  id: number;
  name: string;
  team: string;
};

type ScheduleRow = {
  id: number;
  date: string;
  caddyId: number;
  memo: string | null;
  caddy: Caddy;
};

export default function SchedulePage() {
  const [date, setDate] = useState<string>(() => dayjs().format('YYYY-MM-DD'));
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);

  const dateLabel = useMemo(
    () => dayjs(date).format('YYYY-MM-DD'),
    [date]
  );

  async function fetchSchedules(targetDate: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedules?date=${encodeURIComponent(targetDate)}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      const data: ScheduleRow[] = await res.json();
      setRows(data);
    } catch (err: any) {
      alert(`가용표를 불러오는 중 오류가 발생했습니다.\n\n${err?.message ?? err}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function generateSchedules(targetDate: string) {
    if (!confirm(`${targetDate} 가용표를 자동 생성할까요?`)) return;
    setLoading(true);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: targetDate }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || `HTTP ${res.status}`);
      }
      // 생성 후 바로 새로고침
      await fetchSchedules(targetDate);
      alert(payload?.message || '가용표가 생성되었습니다.');
    } catch (err: any) {
      alert(`가용표 생성 중 오류가 발생했습니다.\n\n${err?.message ?? err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSchedules(date);
  }, [date]);

  return (
    <div style={{ maxWidth: 900, margin: '40px auto' }}>
      <h2 style={{ marginBottom: 16 }}>가용표</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button onClick={() => fetchSchedules(date)} disabled={loading}>
          새로고침
        </button>
        <button onClick={() => generateSchedules(date)} disabled={loading}>
          자동 생성
        </button>
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
        선택일: {dateLabel}
      </div>

      <table width="100%" cellPadding={8} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f4f4f4' }}>
            <th style={th}>ID</th>
            <th style={th}>이름</th>
            <th style={th}>조</th>
            <th style={th}>특이사항</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={4} style={{ textAlign: 'center' }}>로딩 중…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={4} style={{ textAlign: 'center' }}>데이터가 없습니다.</td></tr>
          ) : (
            rows.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={td}>{r.caddy.id}</td>
                <td style={td}>{r.caddy.name}</td>
                <td style={td}>{r.caddy.team}</td>
                <td style={td}>{r.memo || '근무중'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
        * 특이사항 표시는 휴무/병가/장기병가/당번/마샬 순으로 우선 표시됩니다.
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  borderBottom: '1px solid #ddd',
  textAlign: 'left',
};
const td: React.CSSProperties = {
  borderBottom: '1px solid #f6f6f6',
};
