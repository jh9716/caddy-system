// src/app/notice/[id]/page.tsx
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import NoticeActions from "./NoticeActions";

export const dynamic = "force-dynamic";

type Props = { params: { id: string } };

export default async function NoticeDetailPage({ params }: Props) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return notFound();

  const notice = await prisma.notice.findUnique({ where: { id } });
  if (!notice) return notFound();

  // content/body 컬럼 어느 쪽이든 대응
  const content: string | null =
    (notice as any).content ?? (notice as any).body ?? null;

  const store = await cookies();
  const isAdmin = store.get("role")?.value === "admin";

  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: "0 16px" }}>
      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 14,
          boxShadow: "0 6px 18px rgba(15, 23, 42, 0.06)",
          overflow: "hidden",
        }}
      >
        {/* 헤더 */}
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid #eef2f7",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "start",
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>
              {notice.title}
            </h1>
            <time style={{ color: "#94a3b8", fontSize: 13 }}>
              {new Date(notice.createdAt).toLocaleString()}
            </time>
          </div>

          {/* 관리자 전용 액션 */}
          <NoticeActions
            id={id}
            initialTitle={notice.title}
            initialContent={content ?? ""}
            canEdit={isAdmin}
          />
        </div>

        {/* 본문 */}
        <article
          style={{
            padding: 20,
            lineHeight: 1.7,
            color: "#0f172a",
            whiteSpace: "pre-wrap",
          }}
        >
          {content || (
            <span style={{ color: "#64748b" }}>내용이 없습니다.</span>
          )}
        </article>
      </div>

      <div style={{ marginTop: 16 }}>
        <Link href="/notice" style={{ textDecoration: "none", color: "#0f172a" }}>
          ← 공지 목록으로
        </Link>
      </div>
    </main>
  );
}
