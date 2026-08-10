import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = await cookies();
  const role =
    store.get("role")?.value ||
    store.get("session_role")?.value ||
    (store.get("admin")?.value === "1" ? "admin" : null);

  if (role !== "admin") {
    redirect("/login?callbackUrl=/manage");
  }

  return (
    <div className="manage-shell">
      <aside className="manage-aside">
        <div style={{ fontWeight: 800, marginBottom: 12 }}>관리 메뉴</div>
        <nav style={{ display: "grid", gap: 8 }}>
          <a href="/manage" style={linkStyle}>대시보드</a>
          <a href="/manage/caddies" style={linkStyle}>캐디등록/관리</a>
          <a href="/manage/availability" style={linkStyle}>가용계산</a>
          <a href="/notice" style={linkStyle}>공지관리</a>
          <a href="/schedule" style={linkStyle}>가용표</a>
        </nav>
      </aside>
      <section className="manage-main">{children}</section>
      <style>{`
        .manage-shell {
          display: grid;
          grid-template-columns: 1fr;
          gap: 0;
        }
        .manage-aside {
          border-bottom: 1px solid #e5e7eb;
          padding: 12px 16px;
          background: #fff;
        }
        .manage-aside nav {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .manage-main {
          padding: 16px;
        }
        @media (min-width: 860px) {
          .manage-shell {
            grid-template-columns: 220px 1fr;
            min-height: calc(100vh - 60px);
          }
          .manage-aside {
            border-bottom: 0;
            border-right: 1px solid #e5e7eb;
            padding: 16px;
          }
          .manage-aside nav {
            grid-template-columns: 1fr;
          }
          .manage-main {
            padding: 20px;
          }
        }
      `}</style>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  background: "#f8fafc",
  textDecoration: "none",
  color: "#111",
  textAlign: "center",
  fontSize: 14,
};
