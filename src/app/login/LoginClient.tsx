"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginClient() {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || "로그인 실패");

      const callback = searchParams.get("callbackUrl");
      const safeCallback =
        callback && callback.startsWith("/") && !callback.startsWith("//")
          ? callback
          : null;

      if (safeCallback) {
        location.href = safeCallback;
        return;
      }
      location.href = data.role === "admin" ? "/manage" : "/caddy";
    } catch (e: any) {
      setErr(e.message || "로그인 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl border bg-white p-6 shadow">
        <h1 className="mb-6 text-xl font-bold">Verthill Caddy System</h1>

        <label className="mb-1 block text-sm" htmlFor="login-username">아이디</label>
        <input
          id="login-username"
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 w-full rounded-lg border px-3 py-2 outline-none focus:ring"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
        />

        <label className="mb-1 block text-sm" htmlFor="login-password">비밀번호</label>
        <input
          id="login-password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border px-3 py-2 outline-none focus:ring"
          autoComplete="current-password"
        />

        {err && (
          <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-600">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {loading ? "로그인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
