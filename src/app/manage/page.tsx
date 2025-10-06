// src/app/manage/page.tsx
"use client"

import Link from "next/link"

export default function ManagePage() {
  return (
    <div className="p-8 text-center">
      <h1 className="text-2xl font-bold mb-6">관리자 페이지</h1>
      <div className="flex justify-center gap-6">
        <Link
          href="/manage/caddies"
          className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          캐디 등록 / 관리
        </Link>
        <Link
          href="/manage/assignments"
          className="px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600"
        >
          근무 · 휴무 관리
        </Link>
      </div>
    </div>
  )
}
