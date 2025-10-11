"use client";
import { useEffect, useState } from "react";

type Notice = { id:string; title:string; body:string; pinned:boolean; createdAt:string };

export default function NoticePage() {
  const [rows, setRows] = useState<Notice[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  async function load() {
    const r = await fetch("/api/notice", { cache: "no-store" });
    setRows(await r.json());
  }
  useEffect(()=>{ load(); },[]);

  async function create() {
    const r = await fetch("/api/notice", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ title, body, pinned })
    });
    if (!r.ok) return alert("권한이 없거나 실패");
    setTitle(""); setBody(""); setPinned(false);
    load();
  }

  async function del(id:string) {
    if (!confirm("삭제할까요?")) return;
    const r = await fetch(`/api/notice/${id}`, { method:"DELETE" });
    if (r.ok) load(); else alert("삭제 실패");
  }

  // 간단 권한표시(서버세션 연동 전 임시): 관리자면 버튼 보여주기
  useEffect(()=>{ fetch("/api/me").then(()=>setIsAdmin(true)).catch(()=>setIsAdmin(false)); },[]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">공지사항</h1>

      {isAdmin && (
        <div className="border p-4 rounded space-y-2">
          <div className="font-semibold">공지 작성(관리자)</div>
          <input className="border p-2 w-full" placeholder="제목" value={title} onChange={e=>setTitle(e.target.value)} />
          <textarea className="border p-2 w-full min-h-[120px]" placeholder="내용" value={body} onChange={e=>setBody(e.target.value)} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={pinned} onChange={e=>setPinned(e.target.checked)} /> 상단 고정
          </label>
          <button className="border px-4 py-2 rounded" onClick={create}>등록</button>
        </div>
      )}

      <ul className="space-y-3">
        {rows.map(n=>(
          <li key={n.id} className="border rounded p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold">
                {n.pinned && "📌 "}{n.title}
              </div>
              {isAdmin && <button className="text-sm underline" onClick={()=>del(n.id)}>삭제</button>}
            </div>
            <div className="text-sm text-gray-600 mt-1">{new Date(n.createdAt).toLocaleString()}</div>
            <div className="mt-2 whitespace-pre-wrap">{n.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
