"use client";

import { Suspense, FormEvent, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function LoginInner() {
  const q = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const callbackUrl = q.get("callbackUrl") || "/dashboard";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await signIn("credentials", { redirect: false, username, password, callbackUrl });
    if (res?.ok) window.location.href = callbackUrl;
    else alert("로그인 실패");
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <h1 className="text-xl font-bold">로그인</h1>
        <input className="border p-2 w-full" placeholder="아이디" value={username} onChange={e=>setUsername(e.target.value)} />
        <input className="border p-2 w-full" type="password" placeholder="비밀번호" value={password} onChange={e=>setPassword(e.target.value)} />
        <button className="border w-full py-2 rounded">로그인</button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6">로딩중…</div>}>
      <LoginInner />
    </Suspense>
  );
}

// 프리렌더 방지(선택: 추천)
export const dynamic = "force-dynamic";
