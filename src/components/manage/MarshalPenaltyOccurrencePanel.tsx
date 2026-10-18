"use client";

import { useMemo, useRef, useState } from "react";
import {
  OCCURRENCE_PANEL_TITLE,
  canCancelOccurrence,
  canChangeOccurrenceDate,
  makeOccurrenceIdempotencyKey,
  newOccurrenceNonce,
  occurrenceConflictMessage,
  occurrenceRegisterBlocked,
  occurrenceSourceLabel,
  occurrenceStatusLabel,
  occurrenceTargetLabel,
  occurrenceWaitLabel,
  previewChangedNormalNames,
  previewExistingPenaltyNames,
  previewOtherDatesUnchanged,
  previewOverrideNames,
  targetMonthFromOccurredOnYmd,
  type OccurrenceListItem,
  type OccurrencePreviewView,
} from "@/lib/marshalPenaltyOccurrenceUi";

type Member = {
  profileId: number;
  caddyId: number;
  rotationOrder: number;
  name: string;
};

type ApiErrorBody = { error?: string; code?: string };

function readError(json: ApiErrorBody, fallback: string): string {
  return occurrenceConflictMessage({
    code: json.code,
    error: json.error || fallback,
  });
}

export default function MarshalPenaltyOccurrencePanel(input: {
  members: Member[];
  occurrences: OccurrenceListItem[];
  planStatus?: string | null;
  needsRegeneration?: boolean;
  planGenerated?: boolean;
  locked: boolean;
  onMutate: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [caddyId, setCaddyId] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [toDate, setToDate] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [preview, setPreview] = useState<OccurrencePreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const nonceRef = useRef<string | null>(null);
  const names = useMemo(
    () => new Map(input.members.map((row) => [row.caddyId, row.name])),
    [input.members]
  );
  const active = (input.occurrences || []).filter(
    (row) => String(row.status).toUpperCase() !== "CANCELLED"
  );
  const selected = input.occurrences.find((row) => row.id === selectedId) || null;
  const targetHint = targetMonthFromOccurredOnYmd(occurredOn);
  const blocked = occurrenceRegisterBlocked({
    locked: input.locked || localBusy,
    caddyId,
    occurredOn,
    reason,
  });
  const finalized = String(input.planStatus || "").toUpperCase() === "FINALIZED";

  const toggleRow = (id: number) => {
    setSelectedId((current) => (current === id ? null : id));
    setPreview(null);
    setPreviewError(null);
    setConfirmOff(false);
    const row = input.occurrences.find((item) => item.id === id);
    setToDate(row?.scheduledOn || "");
  };

  const runPreview = async () => {
    if (!selected || !toDate) return;
    setLocalBusy(true);
    setPreviewError(null);
    try {
      const res = await fetch(
        `/api/marshals/penalty-occurrences/${selected.id}/schedule/preview`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selected.id, date: toDate }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreview(null);
        setPreviewError(readError(json, "미리보기 실패"));
        return;
      }
      setPreview(json.preview || json);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <section className="ms-panel ui-card" data-marshal-occurrence-panel="1">
      <button
        type="button"
        className="ms-panel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          {OCCURRENCE_PANEL_TITLE}
          {active.length ? ` ${active.length}` : ""}
        </span>
        <span aria-hidden>{open ? "▾" : "›"}</span>
      </button>
      {open ? (
        <div className="ms-panel-body">
          <p className="ms-muted">
            발생일을 넣으면 다음 달이 대상 근무 월이 됩니다. 이 화면의 월은 대상
            근무 월입니다. 월표가 없어도 등록할 수 있습니다.
            {input.needsRegeneration
              ? " 변경된 벌당이 있어 월표 재생성이 필요합니다. 재생성 전에는 마감할 수 없습니다."
              : ""}
          </p>
          <form
            className="ms-occ-form"
            data-marshal-occurrence-register="1"
            onSubmit={(e) => {
              e.preventDefault();
              if (blocked) return;
              void input.onMutate(async () => {
                if (!nonceRef.current) nonceRef.current = newOccurrenceNonce();
                const res = await fetch("/api/marshals/penalty-occurrences", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    caddyId: Number(caddyId),
                    occurredOn,
                    reason: reason.trim(),
                    note: note.trim() || undefined,
                    idempotencyKey: makeOccurrenceIdempotencyKey({
                      caddyId: Number(caddyId),
                      occurredOn,
                      nonce: nonceRef.current,
                    }),
                  }),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) {
                  nonceRef.current = null;
                  throw new Error(readError(json, "벌당 발생 등록 실패"));
                }
                nonceRef.current = null;
                setReason("");
                setNote("");
              });
            }}
          >
            <select
              aria-label="벌당 발생 마샬"
              value={caddyId}
              disabled={input.locked || localBusy}
              onChange={(e) => setCaddyId(e.target.value)}
            >
              <option value="">마샬 선택</option>
              {input.members.map((member) => (
                <option key={member.profileId} value={member.caddyId}>
                  {member.rotationOrder} {member.name}
                </option>
              ))}
            </select>
            <input
              aria-label="벌당 발생일"
              type="date"
              value={occurredOn}
              disabled={input.locked || localBusy}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
            <input
              aria-label="벌당 발생 사유"
              placeholder="사유"
              value={reason}
              disabled={input.locked || localBusy}
              onChange={(e) => setReason(e.target.value)}
            />
            <input
              aria-label="벌당 발생 메모"
              placeholder="메모(선택)"
              value={note}
              disabled={input.locked || localBusy}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="submit"
              className="ui-btn ui-btn-primary"
              disabled={blocked}
            >
              발생 등록
            </button>
          </form>
          {targetHint ? (
            <p className="ms-muted">
              대상 근무 월 {occurrenceTargetLabel(targetHint.year, targetHint.month)} ·
              기본 배정은 자동입니다.
            </p>
          ) : null}

          {input.occurrences.length === 0 ? (
            <p className="ms-muted">이 달 대상 벌당 발생이 없습니다.</p>
          ) : (
            <ul className="ms-occ-list" data-marshal-occurrence-list="1">
              <li className="ms-occ-head" aria-hidden>
                <span>이름</span>
                <span>발생</span>
                <span>배정</span>
                <span>구분</span>
                <span>상태</span>
                <span />
              </li>
              {input.occurrences.map((row) => {
                const wait = occurrenceWaitLabel({
                  status: row.status,
                  deferReason: row.deferReason,
                  planGenerated: input.planGenerated,
                });
                const expanded = selectedId === row.id;
                return (
                  <li
                    key={row.id}
                    className={`ms-occ-item${expanded ? " is-open" : ""}`}
                    data-marshal-occurrence-row={row.id}
                  >
                    <button
                      type="button"
                      className="ms-occ-main"
                      aria-expanded={expanded}
                      onClick={() => toggleRow(row.id)}
                    >
                      <span className="ms-occ-name">
                        {row.caddy?.name || `#${row.caddyId}`}
                      </span>
                      <span className="ms-occ-date">{row.occurredOn.slice(5)}</span>
                      <span className="ms-occ-duty ms-occ-pc">
                        {row.scheduledOn ? row.scheduledOn.slice(5) : "미배정"}
                      </span>
                      <span className={`ms-occ-src is-${String(row.scheduleSource).toLowerCase()}`}>
                        {occurrenceSourceLabel(row.scheduleSource)}
                      </span>
                      <span className={`ms-occ-st is-${String(row.status).toLowerCase()}`}>
                        {occurrenceStatusLabel(row.status)}
                      </span>
                      <span className="ms-dense-more" aria-hidden>
                        {expanded ? "▾" : "›"}
                      </span>
                    </button>
                    {wait ? (
                      <p className="ms-occ-wait">{wait}</p>
                    ) : null}
                    {expanded ? (
                      <div className="ms-occ-detail">
                        <p>
                          발생 {row.occurredOn} · 대상{" "}
                          {occurrenceTargetLabel(row.targetYear, row.targetMonth)} · 배정{" "}
                          {row.scheduledOn || "없음"}
                        </p>
                        <p>사유 {row.reason}{row.note ? ` · ${row.note}` : ""}</p>
                        {row.deferReason ? <p>미배정 {row.deferReason}</p> : null}
                        {canChangeOccurrenceDate({
                          status: row.status,
                          planStatus: input.planStatus,
                        }) ? (
                          <div className="ms-occ-change">
                            <input
                              aria-label="벌당 지정일"
                              type="date"
                              value={toDate}
                              onChange={(e) => {
                                setToDate(e.target.value);
                                setPreview(null);
                                setPreviewError(null);
                                setConfirmOff(false);
                              }}
                            />
                            <button
                              type="button"
                              className="ui-btn"
                              disabled={input.locked || localBusy || !toDate}
                              onClick={() => void runPreview()}
                            >
                              미리보기
                            </button>
                          </div>
                        ) : finalized ? (
                          <p className="ms-muted">마감된 월표의 날짜는 바꿀 수 없습니다.</p>
                        ) : null}
                        {previewError ? (
                          <p className="vh-auth-error" role="alert">
                            {previewError}
                          </p>
                        ) : null}
                        {preview ? (
                          <div
                            className="ms-occ-preview"
                            data-marshal-occurrence-preview="1"
                          >
                            <p>
                              {preview.fromDate || "미배정"} → {preview.toDate}
                            </p>
                            <p>
                              {previewOtherDatesUnchanged(preview)
                                ? "다른 벌당자 날짜는 그대로입니다."
                                : "다른 벌당 날짜 확인이 필요합니다."}
                            </p>
                            {previewExistingPenaltyNames(preview).length > 0 ? (
                              <p>
                                기존 벌당자{" "}
                                {previewExistingPenaltyNames(preview).join("·")}
                              </p>
                            ) : null}
                            {previewChangedNormalNames(preview, names).length > 0 ? (
                              <p>
                                변경되는 정상 마샬{" "}
                                {previewChangedNormalNames(preview, names).join("·")}
                              </p>
                            ) : null}
                            {(preview.rotationImpact?.fillers || []).length > 0 ? (
                              <p>
                                빈자리 대체{" "}
                                {preview.rotationImpact!.fillers!.map((row) => {
                                  const name = names.get(row.caddyId) || `#${row.caddyId}`;
                                  return row.warning ? `${name}(${row.warning})` : name;
                                }).join("·")}
                              </p>
                            ) : null}
                            {previewOverrideNames(preview).length > 0 ? (
                              <p>
                                대타/수동배치{" "}
                                {previewOverrideNames(preview).join("·")}
                              </p>
                            ) : null}
                            {preview.offWarning || preview.requiresOffConfirm ? (
                              <label>
                                <input
                                  type="checkbox"
                                  checked={confirmOff}
                                  onChange={(e) => setConfirmOff(e.target.checked)}
                                />{" "}
                                휴무 충돌을 확인하고 지정합니다
                              </label>
                            ) : null}
                            {preview.slotsDeferred ? (
                              <p className="ms-muted">
                                월표 재생성이 필요해 슬롯은 나중에 반영됩니다.
                              </p>
                            ) : null}
                            <button
                              type="button"
                              className="ui-btn ui-btn-primary"
                              disabled={
                                input.locked ||
                                localBusy ||
                                !preview.previewToken ||
                                ((preview.offWarning || preview.requiresOffConfirm) &&
                                  !confirmOff)
                              }
                              onClick={() =>
                                void input.onMutate(async () => {
                                  const res = await fetch(
                                    `/api/marshals/penalty-occurrences/${row.id}/schedule/apply`,
                                    {
                                      method: "POST",
                                      credentials: "include",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({
                                        id: row.id,
                                        date: toDate,
                                        previewToken: preview.previewToken,
                                        confirmOff,
                                      }),
                                    }
                                  );
                                  const json = await res.json().catch(() => ({}));
                                  if (!res.ok) {
                                    if (json.code === "stale_preview") {
                                      setPreview(null);
                                    }
                                    throw new Error(readError(json, "날짜 변경 실패"));
                                  }
                                  setPreview(null);
                                  setConfirmOff(false);
                                })
                              }
                            >
                              변경 확정
                            </button>
                          </div>
                        ) : null}
                        {canCancelOccurrence({
                          status: row.status,
                          planStatus: input.planStatus,
                        }) ? (
                          <button
                            type="button"
                            className="ui-btn"
                            data-marshal-occurrence-cancel="1"
                            disabled={input.locked || localBusy}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  "이 벌당 발생을 취소할까요? 다른 벌당자와 수동 대타는 삭제되지 않습니다. 초안 월표는 재생성이 필요할 수 있습니다."
                                )
                              ) {
                                return;
                              }
                              void input.onMutate(async () => {
                                const res = await fetch(
                                  `/api/marshals/penalty-occurrences/${row.id}/cancel`,
                                  {
                                    method: "POST",
                                    credentials: "include",
                                  }
                                );
                                const json = await res.json().catch(() => ({}));
                                if (!res.ok) {
                                  throw new Error(readError(json, "취소 실패"));
                                }
                                setSelectedId(null);
                                setPreview(null);
                              });
                            }}
                          >
                            취소
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
