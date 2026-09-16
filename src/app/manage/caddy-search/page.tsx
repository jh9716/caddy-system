"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { kstYmd } from "@/lib/kstDate";
import { employmentStatusLabel } from "@/lib/caddyManage";
import {
  CADDY_SEARCH_DEBOUNCE_MS,
  todayPlacementSummary,
  type CaddySearchApiHit,
  type SearchPlacementHit,
} from "@/lib/caddySearch";

export default function ManageCaddySearchPage() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CaddySearchApiHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placements, setPlacements] = useState<SearchPlacementHit[] | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    const date = kstYmd();
    (async () => {
      try {
        const res = await fetch(
          `/api/assignments/published?date=${encodeURIComponent(date)}`,
          { credentials: "include" }
        );
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        const list = data?.published?.payload?.placements;
        if (cancelled || !Array.isArray(list)) return;
        const next: SearchPlacementHit[] = list.map((row: Record<string, unknown>) => {
          const rawId = row?.caddyId;
          const parsed = typeof rawId === "number" ? rawId : Number(rawId);
          return {
            caddyId: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
            shift: String(row?.shift ?? ""),
            teeTime: String(row?.teeTime ?? ""),
            course: String(row?.course ?? ""),
          };
        });
        setPlacements(next);
      } catch {
        if (!cancelled) setPlacements(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const q = query.replace(/\u00a0/g, " ").trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const ctrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/caddies/search?q=${encodeURIComponent(q)}`,
          { credentials: "include", signal: ctrl.signal }
        );
        if (res.status === 401) {
          setError("관리자만 사용할 수 있습니다.");
          setHits([]);
          return;
        }
        if (!res.ok) {
          setError("검색에 실패했습니다.");
          setHits([]);
          return;
        }
        const data = await res.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        setHits(results);
        setError(null);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof Error && e.name === "AbortError") return;
        setError("검색에 실패했습니다.");
        setHits([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, CADDY_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  return (
    <div className="cs-page">
      <header className="cs-head">
        <div>
          <h1 className="cs-title">캐디 검색</h1>
          <p className="cs-sub">
            이름 · 조 · 번호 · 휴대폰 뒤자리. 연락처는 관리자만 봅니다.
          </p>
        </div>
        <Link href="/manage/caddies" className="cs-link">
          캐디 관리
        </Link>
      </header>

      <label className="cs-search-label">
        통합검색
        <input
          type="search"
          className="cs-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="김현정 / 7조 / 123 / 5678"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="캐디 통합검색"
        />
      </label>

      {error ? (
        <p className="cs-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="cs-muted">검색 중…</p> : null}

      {!loading && !query.trim() ? (
        <p className="cs-empty">이름, 조, 캐디 번호, 휴대폰 뒤 4자리를 입력하세요.</p>
      ) : null}

      {!loading && query.trim() ? (
        <p className="cs-count">{hits.length}명</p>
      ) : null}

      <ul className="cs-list">
        {hits.map((hit) => {
          const telHref = hit.hasPhone && hit.telPhone ? `tel:${hit.telPhone}` : null;
          const today = todayPlacementSummary(placements, hit.id);
          const statusLabel = employmentStatusLabel(hit.employmentStatus);
          const typeLabel = String(hit.caddyType ?? "HOUSE").trim() || "HOUSE";
          return (
            <li key={hit.id} className="cs-card">
              <div className="cs-card-main">
                <strong className="cs-name">{hit.name}</strong>
                <div className="cs-meta">
                  {hit.team || "조 없음"} · {typeLabel} · {statusLabel}
                </div>
                <div
                  className={`cs-phone${!hit.hasPhone ? " is-missing" : ""}`}
                >
                  {!hit.hasPhone ? "연락처 등록 필요" : hit.maskedPhone}
                </div>
                {today ? <div className="cs-today">오늘 배치 {today}</div> : null}
              </div>
              <div className="cs-actions">
                {telHref ? (
                  <a className="cs-btn cs-btn-call" href={telHref}>
                    전화
                  </a>
                ) : (
                  <span className="cs-btn is-disabled" aria-disabled="true">
                    전화
                  </span>
                )}
                <Link
                  className="cs-btn"
                  href={`/manage/caddies?id=${hit.id}`}
                >
                  상세
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      <style>{`
        .cs-page { max-width: 720px; padding-bottom: 24px; }
        .cs-head {
          display: flex; justify-content: space-between; gap: 12px;
          align-items: flex-end; margin-bottom: 16px;
        }
        .cs-title {
          margin: 0; font-size: 1.35rem; font-weight: 800;
          color: var(--vh-green-900);
        }
        .cs-sub {
          margin: 4px 0 0; font-size: 0.8rem; color: var(--vh-muted);
        }
        .cs-link {
          font-size: 0.8rem; font-weight: 700; color: var(--vh-green-800);
          white-space: nowrap;
        }
        .cs-search-label {
          display: grid; gap: 6px; font-size: 0.74rem; font-weight: 700;
          color: var(--vh-ink-soft);
        }
        .cs-search {
          width: 100%; min-height: 44px; padding: 8px 12px;
          border: 1px solid var(--vh-border-strong); border-radius: 10px;
          font-size: 1rem; font-family: var(--font-sans);
        }
        .cs-error { color: var(--vh-danger); font-size: 0.82rem; }
        .cs-muted, .cs-empty, .cs-count {
          font-size: 0.8rem; color: var(--vh-muted);
        }
        .cs-count { font-weight: 700; }
        .cs-list {
          list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px;
        }
        .cs-card {
          display: flex; justify-content: space-between; gap: 10px;
          align-items: center;
          padding: 12px; border: 1px solid var(--vh-border);
          border-radius: 12px; background: var(--vh-paper);
        }
        .cs-name { font-size: 1rem; color: var(--vh-green-900); }
        .cs-meta { margin-top: 3px; font-size: 0.78rem; color: var(--vh-muted); }
        .cs-phone { margin-top: 6px; font-size: 0.86rem; font-weight: 700; }
        .cs-phone.is-missing { color: var(--vh-muted); font-weight: 600; }
        .cs-today { margin-top: 4px; font-size: 0.74rem; color: var(--vh-green-800); }
        .cs-actions { display: grid; gap: 6px; min-width: 72px; }
        .cs-btn {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 36px; padding: 4px 10px; border-radius: 8px;
          border: 1px solid var(--vh-border-strong); background: var(--vh-paper);
          font-size: 0.78rem; font-weight: 700; color: var(--vh-ink);
          text-align: center; text-decoration: none;
        }
        .cs-btn-call {
          background: var(--vh-green-900); border-color: var(--vh-green-900);
          color: #fff;
        }
        .cs-btn.is-disabled {
          opacity: 0.45; cursor: not-allowed; pointer-events: none;
        }
      `}</style>
    </div>
  );
}
