import { prisma } from "@/lib/prisma";
import NewNoticeForm from "@/app/notice/new/ui/NewNoticeForm";
import Link from "next/link";
import { notFound } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function EditNoticePage({
  params,
}: {
  params: { id: string };
}) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) notFound();

  const notice = await prisma.notice.findUnique({ where: { id } });
  if (!notice) {
    return (
      <div className="container-page py-8">
        <p className="text-slate-600">존재하지 않는 공지입니다.</p>
        <Link href="/notice" className="btn btn-ghost mt-4">
          ← 공지 목록으로
        </Link>
      </div>
    );
  }

  // 스키마가 프로젝트마다 달라서 body/content 둘 다 케어
  const body =
    (notice as any).body ??
    (notice as any).content ??
    "";

  return (
    <div className="container-page py-8">
      <h1 className="mb-6 text-xl font-semibold">공지 수정</h1>
      <NewNoticeForm
        mode="edit"
        initial={{ id, title: (notice as any).title, body }}
      />
    </div>
  );
}
