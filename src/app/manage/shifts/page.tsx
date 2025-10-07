'use client';
import { useState } from 'react';

const parts = [
  { v: 'ONE', label: '1부' },
  { v: 'TWO', label: '2부' },
  { v: 'THREE', label: '3부' },
];
const variants = [
  { v: 'NORMAL', label: '일반' },
  { v: 'ONE_THREE', label: '1·3부' },
  { v: 'ONE_TWO', label: '1·2부' },
  { v: 'FIFTY_FOUR', label: '54홀' },
];

function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function ManageShiftsPage() {
  const [date, setDate] = useState(ymd());
  const [part, setPart] = useState('ONE');
  const [variant, setVariant] = useState('NORMAL');
  const [slots, setSlots] = useState(2);
  const [teams, setTeams] = useState('5조,8조'); // 쉼표 구분

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // ✅ 근무표 생성
  async function generate() {
    try {
      setLoading(true);
      const body = {
        date,
        part,
        variant,
        slotsPerTeam: Number(slots),
        teams: teams.split(',').map(s => s.trim()).filter(Boolean),
      };

      const res = await fetch('/api/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include', // ✅ 쿠키 포함
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || '생성 실패');
        return;
      }
      alert(`근무표 생성 완료: ${data.count}명`);
      await load();
    } catch (err) {
      alert('네트워크 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  // ✅ 근무표 조회
  async function load() {
    try {
      setLoading(true);
      const res = await fetch(`/api/shifts?date=${date}&part=${part}`, {
        credentials: 'include', // ✅ 쿠키 포함
      });
      const data = await res.json();
      if (res.ok) setRows(data);
      else {
        setRows([]);
        alert(data?.error || '조회 실패');
      }
    } catch {
      alert('네트워크 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>근무표 생성</h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr 1fr 2fr auto',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        <select value={part} onChange={e => setPart(e.target.value)}>
          {parts.map(p => (
            <option key={p.v} value={p.v}>
              {p.label}
            </option>
          ))}
        </select>
        <select value={variant} onChange={e => setVariant(e.target.value)}>
          {variants.map(v => (
            <option key={v.v} value={v.v}>
              {v.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          value={slots}
          onChange={e => setSlots(Number(e.target.value))}
          placeholder="팀별 인원"
        />
        <input
          value={teams}
          onChange={e => setTeams(e.target.value)}
          placeholder="팀 목록 (예: 5조,8조)"
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={generate} disabled={loading}>
            {loading ? '처리 중...' : '생성'}
          </button>
          <button onClick={load} disabled={loading}>
            조회
          </button>
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
        <thead>
          <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
            <th style={th}>순번</th>
            <th style={th}>팀</th>
            <th style={th}>이름</th>
            <th style={th}>부</th>
            <th style={th}>변형</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td style={td} colSpan={5}>
                데이터 없음
              </td>
            </tr>
          ) : (
            rows.map((r: any) => (
              <tr
                key={r.id}
                style={{ borderBottom: '1px solid #f1f5f9', textAlign: 'center' }}
              >
                <td style={td}>{r.orderNo}</td>
                <td style={td}>{r.team || r.caddy?.team || ''}</td>
                <td style={td}>{r.caddy?.name || r.caddyId}</td>
                <td style={td}>{r.part}</td>
                <td style={td}>{r.variant}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px', fontSize: 13, color: '#334155' };
const td: React.CSSProperties = { padding: '8px', fontSize: 14, color: '#0f172a' };
