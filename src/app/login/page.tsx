'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    alert(data.message || (res.ok ? '로그인 성공' : '로그인 실패'));
    if (res.ok) {
      // 홈으로 이동
      window.location.href = '/';
    }
  }

  return (
    <div style={{maxWidth: 360, margin: '80px auto', padding: 20, border: '1px solid #eee', borderRadius: 12, background: '#fff'}}>
      <h2 style={{fontSize: 20, fontWeight: 700, marginBottom: 16}}>로그인</h2>
      <form onSubmit={onSubmit} style={{display:'grid', gap: 12}}>
        <input
          placeholder="아이디 (예: caddy 또는 admin)"
          value={username}
          onChange={e=>setUsername(e.target.value)}
          style={{padding:10, border:'1px solid #ddd', borderRadius:10}}
        />
        <input
          type="password"
          placeholder="비밀번호"
          value={password}
          onChange={e=>setPassword(e.target.value)}
          style={{padding:10, border:'1px solid #ddd', borderRadius:10}}
        />
        <button type="submit" style={{padding:'10px 12px', border:'1px solid #e5e7eb', borderRadius:10, background:'#111', color:'#fff'}}>
          로그인
        </button>
        <p style={{fontSize:12, color:'#6b7280', lineHeight:1.5}}>
          • 캐디 공용계정: <b>{process.env.NEXT_PUBLIC_EXAMPLE_CADDY_USER ?? 'caddy'}</b><br/>
          • 관리자 계정은 개별 아이디/비밀번호 사용
        </p>
      </form>
    </div>
  );
}
