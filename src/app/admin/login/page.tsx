'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get('next') || '/assignments';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.message || '로그인 실패');
      }
      router.replace(next);
    } catch (e: any) {
      setErr(e.message || '로그인 실패');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-sm mx-auto">
      <h1 className="text-xl font-bold mb-4">관리자 로그인</h1>
      <form onSubmit={onSubmit} className="space-y-3">
        <input
          type="password"
          placeholder="관리자 비밀번호"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border w-full px-3 py-2 rounded"
        />
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button
          disabled={loading}
          className="border px-4 py-2 rounded hover:bg-gray-50 disabled:opacity-60"
        >
          {loading ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  );
}
