"use client";

import { useCallback, useEffect, useState } from "react";
import {
  privacyRequestKindLabel,
  privacyRequestTopicLabel,
  type AdminPrivacyRequestRow,
} from "@/lib/privacyRequestInbox";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function PrivacyRequestsInbox() {
  const [items, setItems] = useState<AdminPrivacyRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/privacy-requests", {
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as {
        items?: AdminPrivacyRequestRow[];
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.message || data.error || "목록 조회 실패");
      }
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "목록 조회 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="pt-page privacy-inbox">
      <header className="pt-head">
        <h1 className="pt-title">개인정보 요청</h1>
        <p className="pt-sub">
          계정 삭제 요청과 개인정보 문의를 확인합니다. 이 화면에서 계정을
          삭제하거나 익명화하지 않습니다.
        </p>
      </header>

      {error ? <p className="privacy-form-error">{error}</p> : null}

      {loading ? (
        <p>불러오는 중…</p>
      ) : (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>요청 시각</th>
                <th>유형</th>
                <th>계정 식별</th>
                <th>회신 이메일</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5}>접수된 요청이 없습니다.</td>
                </tr>
              ) : (
                items.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>{formatWhen(row.createdAt)}</td>
                    <td>
                      {privacyRequestKindLabel(row.kind)}
                      {row.topic ? ` · ${privacyRequestTopicLabel(row.topic)}` : ""}
                    </td>
                    <td>{row.accountIdentifier || "—"}</td>
                    <td>{row.replyEmail || "—"}</td>
                    <td className="privacy-inbox-note">{row.note || "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <style>{`
        .pt-page { max-width: 960px; padding-bottom: 24px; }
        .pt-head { margin-bottom: 16px; }
        .pt-title {
          margin: 0; font-size: 1.35rem; font-weight: 800;
          color: var(--vh-green-900);
        }
        .pt-sub { margin: 4px 0 0; font-size: 0.8rem; color: var(--vh-muted); }
        .privacy-inbox-note { max-width: 280px; white-space: pre-wrap; }
      `}</style>
    </div>
  );
}
