"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  groupDirectEditCandidates,
  listDirectEditCandidates,
  type DirectEditCandidate,
} from "@/lib/assignmentBoardCellEdit";
import type { AssignmentDraft } from "@/lib/assignmentDraft";
import type { AutoAssignmentRow } from "@/lib/autoAssignEngine";
import { formatCaddyLabel } from "@/lib/caddyDisplay";

export function CaddyCellEditSheet({
  draft,
  row,
  unavailableCaddyIds,
  onClose,
  onSelect,
  onOpenDutyMenu,
}: {
  draft: AssignmentDraft;
  row: AutoAssignmentRow;
  unavailableCaddyIds?: Iterable<number>;
  onClose: () => void;
  onSelect: (caddyId: number) => void;
  onOpenDutyMenu: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const currentId = row.caddy.id > 0 ? row.caddy.id : null;

  const candidates = useMemo(
    () =>
      listDirectEditCandidates(draft, {
        shift: row.reservation.shift || row.shift,
        currentCaddyId: currentId,
        query,
        unavailableCaddyIds,
      }),
    [draft, row, currentId, query, unavailableCaddyIds]
  );
  const groups = useMemo(() => groupDirectEditCandidates(candidates), [candidates]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const vacant = !String(row.caddy.name || "").trim();
  const title = vacant ? "빈 칸" : formatCaddyLabel(row.caddy);

  return (
    <div className="qa-overlay" role="presentation" onClick={onClose}>
      <div
        className="qa-sheet de-sheet"
        role="dialog"
        aria-label="캐디 직접선택"
        data-caddy-picker="1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qa-sheet-head">
          <div className="qa-sheet-title">
            <strong className="qa-title">{title}</strong>
            <span className="qa-sub">
              {row.reservation.shift} {row.reservation.teeTime} · 직접선택
            </span>
          </div>
          <button type="button" className="btn tiny ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        <label className="de-search">
          <span>이름·조 검색</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            inputMode="search"
            autoComplete="off"
            placeholder="이름 또는 조"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <CandidateGroup
          title="현재 선택"
          empty="현재 캐디 없음"
          items={groups.current}
          onSelect={onSelect}
        />
        <CandidateGroup
          title="이 부 배치"
          empty="이 부에 다른 배치 없음"
          items={groups.assigned}
          onSelect={onSelect}
        />
        <CandidateGroup
          title="미배치 / 스페어"
          empty="미배치 캐디 없음"
          items={groups.unassigned}
          onSelect={onSelect}
        />
        <button type="button" className="btn ghost de-duty" onClick={onOpenDutyMenu}>
          병가·결근 등 업무 메뉴
        </button>
      </div>
    </div>
  );
}

function CandidateGroup({
  title,
  empty,
  items,
  onSelect,
}: {
  title: string;
  empty: string;
  items: DirectEditCandidate[];
  onSelect: (caddyId: number) => void;
}) {
  return (
    <section className="de-group" aria-label={title}>
      <div className="de-group-title">{title}</div>
      {items.length === 0 ? (
        <div className="qa-empty">{empty}</div>
      ) : (
        <ul className="de-list">
          {items.map((item) => {
            const selected = item.group === "current";
            const meta =
              item.group === "assigned" && item.teeTime
                ? `${item.teeTime}${item.teamName ? ` ${item.teamName}` : ""}`
                : item.caddy.team || "";
            return (
              <li key={`${item.group}-${item.caddy.id}`}>
                <button
                  type="button"
                  className={`de-item${selected ? " on" : ""}`}
                  data-caddy-candidate={item.caddy.id}
                  data-caddy-group={item.group}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(item.caddy.id)}
                >
                  <span className="de-item-name">{formatCaddyLabel(item.caddy)}</span>
                  <span className="de-item-meta">{meta}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
