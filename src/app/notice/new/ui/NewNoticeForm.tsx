"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewNoticeForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "등록 실패");
      router.push("/notice");
      router.refresh();
    } catch (e: any) {
      setErr(e.message || "등록 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border bg-white p-4">
      <div>
        <label className="mb-1 block text-sm">제목</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border px-3 py-2 outline-none focus:ring"
          required
        />
      </div>
      <div>
        <label className="mb-1 block text-sm">내용</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="h-40 w-full resize-none rounded-lg border px-3 py-2 outline-none focus:ring"
        />
      </div>

      {err && (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-600">{err}</div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => history.back()}
          className="rounded-md border px-3 py-1.5 hover:bg-slate-50"
        >
          취소
        </button>
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-slate-900 px-4 py-1.5 font-medium text-white disabled:opacity-60"
        >
          {loading ? "저장 중…" : "저장"}
        </button>
      </div>
    </form>
  );
}
