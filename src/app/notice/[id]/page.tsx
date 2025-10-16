import { cookies } from 'next/headers'
import NoticeActions from './NoticeActions'

async function getNotice(id: number) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/notice/${id}`, { cache: 'no-store' })
  if (!res.ok) return null
  return res.json()
}

export default async function NoticeDetailPage({ params }: { params: { id: string } }) {
  const id = Number(params.id)
  const notice = await getNotice(id)
  if (!notice) {
    return <div className="container-page py-8">존재하지 않는 공지입니다.</div>
  }

  const store = await cookies()
  const role = store.get('role')?.value
  const isAdmin = role === 'admin'

  return (
    <div className="container-page py-8">
      <div className="flex items-start justify-between">
        <h1 className="text-2xl font-bold">{notice.title}</h1>
        <span className="text-sm text-slate-400">
          {new Date(notice.createdAt).toLocaleString()}
        </span>
      </div>

      <div className="prose mt-6 max-w-none whitespace-pre-wrap">
        {notice.body}
      </div>

      <a href="/notice" className="mt-6 inline-block text-slate-500 hover:text-slate-900">
        ← 공지 목록으로
      </a>

      {/* 관리자만 수정/삭제 */}
      <NoticeActions id={id} isAdmin={isAdmin} />
    </div>
  )
}
