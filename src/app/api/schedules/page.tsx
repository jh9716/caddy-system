'use client';
import { useState } from 'react';

export default function SchedulePage() {
  const [date, setDate] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    if (!date) {
      alert('날짜를 선택하세요');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const result = await res.json();
      setData(result);
    } catch (e) {
      alert('생성 실패');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoad() {
    if (!date) return;
    const res = await fetch(`/api/schedule?date=${date}`);
    const result = await res.json();
    setData(result);
  }

  return (
    <main className="p-6">
      <h1 className="text-lg font-semibold mb-4">📅 가용표 생성</h1>
      <div className="flex gap-2 mb-4">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border px-2 py-1"
        />
        <button onClick={handleGenerate} disabled={loading} className="border px-3 py-1">
          {loading ? '생성 중...' : '가용표 생성'}
        </button>
        <button onClick={handleLoad} className="border px-3 py-1">
          불러오기
        </button>
      </div>

      {data && (
        <table className="border min-w-[600px]">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-3 py-1">날짜</th>
              <th className="border px-3 py-1">근무</th>
              <th className="border px-3 py-1">휴무</th>
              <th className="border px-3 py-1">병가</th>
              <th className="border px-3 py-1">장기병가</th>
              <th className="border px-3 py-1">당번</th>
              <th className="border px-3 py-1">마샬</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border px-3 py-1">{data.date?.slice(0, 10)}</td>
              <td className="border px-3 py-1 text-center">{data.available}</td>
              <td className="border px-3 py-1 text-center">{data.rest}</td>
              <td className="border px-3 py-1 text-center">{data.sick}</td>
              <td className="border px-3 py-1 text-center">{data.longSick}</td>
              <td className="border px-3 py-1 text-center">{data.duty}</td>
              <td className="border px-3 py-1 text-center">{data.marshal}</td>
            </tr>
          </tbody>
        </table>
      )}
    </main>
  );
}
