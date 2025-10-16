import NewNoticeForm from '@/app/notice/new/ui/NewNoticeForm'

async function getNotice(id: number) {
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/notice/${id}`, { cache: 'no-store' })
  if (!res.ok) return null
  return res.json()
}

export default async function EditNoticePage({ params }: { params: { id: string } }) {
  const id = Number(params.id)
  const notice = await getNotice(id)
  if (!notice) return <div className="container-page py-8">존재하지 않는 공지입니다.</div>

  return (
    <div className="container-page py-8">
      <h1 className="mb-6 text-xl font-semibold">공지 수정</h1>
      <NewNoticeForm mode="edit" initial={{ id, title: notice.title, body: notice.body }} />
    </div>
  )
}
