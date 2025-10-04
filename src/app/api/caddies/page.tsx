// src/app/caddies/page.tsx
"use client";

import { useEffect, useState } from "react";

export default function CaddiesPage() {
  const [caddies, setCaddies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCaddies = async () => {
      try {
        const res = await fetch("/api/caddies");
        const data = await res.json();
        setCaddies(data);
      } catch (error) {
        console.error("데이터를 불러오지 못했습니다:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchCaddies();
  }, []);

  if (loading) return <p>불러오는 중...</p>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">캐디 리스트</h1>
      <table className="w-full border-collapse border border-gray-300">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-gray-300 p-2">ID</th>
            <th className="border border-gray-300 p-2">이름</th>
            <th className="border border-gray-300 p-2">조</th>
            <th className="border border-gray-300 p-2">상태</th>
          </tr>
        </thead>
        <tbody>
          {caddies.map((caddy) => (
            <tr key={caddy.id}>
              <td className="border border-gray-300 p-2">{caddy.id}</td>
              <td className="border border-gray-300 p-2">{caddy.name}</td>
              <td className="border border-gray-300 p-2">{caddy.team}</td>
              <td className="border border-gray-300 p-2">{caddy.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
