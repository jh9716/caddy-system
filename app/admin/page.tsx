'use client';
import Link from 'next/link';

export default function AdminHome() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-lg font-semibold mb-6">관리</h1>
      <ul className="list-disc pl-5 space-y-2">
        <li><Link className="underline" href="/admin/caddies">캐디 등록</Link></li>
        <li><Link className="underline" href="/admin/assignments">캐디 관리(휴무/병가/장기병가/당번/마샬)</Link></li>
      </ul>
    </div>
  );
}
