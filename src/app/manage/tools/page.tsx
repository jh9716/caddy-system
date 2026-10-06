import Link from "next/link";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { isAccountManagerAuth } from "@/lib/staffAdminAccounts";
import {
  ADMIN_LEGACY_TOOL_NOTE,
  ADMIN_LEGACY_TOOLS_SUMMARY,
  groupAdminToolItems,
  legacyAdminToolItems,
  manageToolItems,
  primaryAdminToolItems,
} from "@/lib/adminManageNav";

export const dynamic = "force-dynamic";

export default async function ManageToolsPage() {
  const auth = await getRequestAuthUser();
  const tools = manageToolItems(isAccountManagerAuth(auth ?? {}));
  const groups = groupAdminToolItems(primaryAdminToolItems(tools));
  const legacy = legacyAdminToolItems(tools);

  return (
    <div className="tools-page">
      <header className="tools-head">
        <h1 className="tools-title">관리도구</h1>
        <p className="tools-sub">
          기존 화면으로 이동합니다. 주소·권한은 그대로입니다.
        </p>
      </header>

      {groups.map((section) => (
        <section key={section.group} className="tools-section">
          <h2 className="tools-section-title">{section.label}</h2>
          <div className="tools-list">
            {section.items.map((item) => (
              <Link key={item.href} href={item.href} className="tools-row">
                <span className="tools-row-text">
                  <strong className="tools-row-name">{item.label}</strong>
                  <span className="tools-row-desc">{item.description}</span>
                </span>
                <span className="tools-row-go">열기</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {legacy.length > 0 ? (
        <details className="tools-legacy">
          <summary className="tools-legacy-summary">
            {ADMIN_LEGACY_TOOLS_SUMMARY}
          </summary>
          <div className="tools-list tools-legacy-list">
            {legacy.map((item) => (
              <Link key={item.href} href={item.href} className="tools-row">
                <span className="tools-row-text">
                  <strong className="tools-row-name">{item.label}</strong>
                  <span className="tools-row-note">{ADMIN_LEGACY_TOOL_NOTE}</span>
                  <span className="tools-row-desc">{item.description}</span>
                </span>
                <span className="tools-row-go">열기</span>
              </Link>
            ))}
          </div>
        </details>
      ) : null}

      <style>{`
        .tools-page { max-width: 720px; margin: 0 auto; }
        .tools-head { margin-bottom: 10px; }
        .tools-title {
          margin: 0;
          font-family: var(--font-display-kr);
          font-size: 1.2rem; font-weight: 700;
          color: var(--vh-green-900); line-height: 1.1;
        }
        .tools-sub { margin: 4px 0 0; color: var(--vh-muted); font-size: 0.72rem; }
        .tools-section { margin-bottom: 12px; }
        .tools-section-title {
          margin: 0 0 6px;
          font-size: 0.72rem; font-weight: 800;
          color: var(--vh-green-800); letter-spacing: 0.04em;
        }
        .tools-list {
          border: 1px solid var(--vh-border);
          border-radius: 8px;
          overflow: hidden;
          background: var(--vh-paper);
        }
        .tools-row {
          display: flex; align-items: center; justify-content: space-between;
          gap: 10px; min-height: 44px; padding: 7px 10px;
          border-top: 1px solid var(--vh-border);
          text-decoration: none; color: inherit;
        }
        .tools-row:first-child { border-top: 0; }
        .tools-row-text { min-width: 0; display: grid; gap: 1px; }
        .tools-row-name {
          font-size: 0.86rem; font-weight: 800; color: var(--vh-green-900);
        }
        .tools-row-note {
          font-size: 0.62rem; font-weight: 700; color: var(--vh-green-800);
        }
        .tools-row-desc {
          font-size: 0.68rem; color: var(--vh-muted);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .tools-row-go {
          flex: 0 0 auto;
          font-size: 0.68rem; font-weight: 800;
          color: var(--vh-green-800);
        }
        .tools-legacy {
          margin: 18px 0 0;
        }
        .tools-legacy-summary {
          cursor: pointer;
          font-size: 0.7rem;
          font-weight: 700;
          color: var(--vh-muted);
          list-style: none;
        }
        .tools-legacy-summary::-webkit-details-marker { display: none; }
        .tools-legacy-summary::before {
          content: "▸ ";
          font-size: 0.62rem;
        }
        .tools-legacy[open] > .tools-legacy-summary::before { content: "▾ "; }
        .tools-legacy-list { margin-top: 6px; }
      `}</style>
    </div>
  );
}
