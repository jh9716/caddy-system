'use client';

import { useEffect, useState } from 'react';

type Notice = {
  id: number;
  title: string;
  content: string;
  createdAt: string;
};

export default function NoticePage() {
  const [list, setList] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  async function load() {
    try {
      setLoading(true);
      const res = await fetch('/api/notice', { cache: 'no-store' });
      const data = await res.json();
      setList(data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onCreate() {
    if (!title.trim()) return alert('제목을 입력하세요.');
    const res = await fetch('/api/notice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    const data = await res.json();
    if (!res.ok) return alert(`등록 실패: ${data?.error ?? 'unknown'}`);
    setTitle('');
    setContent('');
    await load();
  }

  async function onDelete(id: number) {
    if (!confirm('정말 삭제할까요?')) return;
    const res = await fetch(`/api/notice/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(`삭제 실패: ${data?.error ?? 'unknown'}`);
    await load();
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <h2 style={{ fontSize: 20, fontWeight: 800 }}>공지사항</h2>

      {/* 등록 폼 */}
      <div style={{ display: 'grid', gap: 8, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, background: '#fff' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#6b7280' }}>제목</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="제목을 입력하세요"
            style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 10px' }}
          />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <label style={{ fontSize: 12, color: '#6b7280' }}>내용</label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="내용을 입력하세요"
            rows={4}
            style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 10px', resize: 'vertical' }}
          />
        </div>
        <div>
          <button onClick={onCreate} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#f1f5f9' }}>
            등록
          </button>
          <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>※ 관리자 로그인 상태에서만 등록/삭제 가능</span>
        </div>
      </div>

      {/* 목록 */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead style={{ background: '#f8fafc' }}>
            <tr>
              <th style={th}>ID</th>
              <th style={th}>제목</th>
              <th style={th}>등록일</th>
              <th style={th}>액션</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} style={td}>불러오는 중…</td></tr>
            ) : list.length === 0 ? (
              <tr><td colSpan={4} style={td}>등록된 공지가 없습니다.</td></tr>
            ) : (
              list.map(n => (
                <tr key={n.id}>
                  <td style={td}>{n.id}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600 }}>{n.title}</div>
                    {n.content && <div style={{ marginTop: 4, fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{n.content}</div>}
                  </td>
                  <td style={td}>{new Date(n.createdAt).toLocaleString()}</td>
                  <td style={td}>
                    <button onClick={() => onDelete(n.id)} style={dangerBtn}>삭제</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #e5e7eb', fontSize: 13, color: '#6b7280' };
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid #f1f5f9', textAlign: 'center', fontSize: 14 };
const dangerBtn: React.CSSProperties = { padding: '6px 10px', borderRadius: 8, border: '1px solid #ef4444', color: '#ef4444', background: '#fff' };
