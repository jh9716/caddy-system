"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarshalManageNav from "@/components/manage/MarshalManageNav";
import { shiftLabel, sourceLabel } from "@/lib/marshalRotationDomain";

type Member = {
  profileId: number;
  caddyId: number;
  rotationOrder: number;
  name: string;
};

type Slot = {
  id: number;
  date: string;
  shift: "AM" | "PM";
  slotIndex: number;
  caddyId: number;
  source: string;
  warning: string | null;
  note: string | null;
  caddy: { id: number; name: string; team: string };
  originalCaddy?: { id: number; name: string } | null;
};

type Penalty = {
  id: number;
  date: string;
  shift: string;
  caddyId: number;
  reason: string;
  note: string | null;
  caddy: { id: number; name: string };
};

type CreditRemain = {
  profileId: number;
  caddyId: number;
  name: string;
  remaining: number;
};

type OpenCredit = {
  id: number;
  marshalProfileId: number;
  reason: string | null;
  caddy: { name: string };
};

type PlanPayload = {
  year: number;
  month: number;
  suggestedStartRotationOrder: number | null;
  members: Member[];
  credits: OpenCredit[];
  creditRemaining: CreditRemain[];
  plan: {
    id: number;
    amSlotsPerDay: number;
    pmSlotsPerDay: number;
    status: string;
    startRotationOrder: number;
    nextRotationOrder: number;
    generatedAt: string | null;
    slots: Slot[];
    penalties: Penalty[];
  } | null;
};

function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export default function ManageMarshalSchedulePage() {
  const initial = currentYearMonth();
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));
  const [data, setData] = useState<PlanPayload | null>(null);
  const [amSlots, setAmSlots] = useState("2");
  const [pmSlots, setPmSlots] = useState("1");
  const [startOrder, setStartOrder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [penaltyDate, setPenaltyDate] = useState("");
  const [penaltyCaddyId, setPenaltyCaddyId] = useState("");
  const [penaltyShift, setPenaltyShift] = useState("AM");
  const [penaltyReason, setPenaltyReason] = useState("");
  const [subSlotId, setSubSlotId] = useState<number | null>(null);
  const [subCaddyId, setSubCaddyId] = useState("");
  const [subNote, setSubNote] = useState("");
  const [applyCredit, setApplyCredit] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(
      `/api/marshals/plans?year=${year}&month=${month}`,
      { credentials: "include" }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || "월표 조회 실패");
    setData(json);
    if (json.plan) {
      setAmSlots(String(json.plan.amSlotsPerDay));
      setPmSlots(String(json.plan.pmSlotsPerDay));
      setStartOrder(String(json.plan.startRotationOrder));
    } else if (json.suggestedStartRotationOrder != null) {
      setStartOrder(String(json.suggestedStartRotationOrder));
    }
  }, [year, month]);

  useEffect(() => {
    void load().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "조회 실패");
    });
  }, [load]);

  const days = useMemo(() => {
    const slots = data?.plan?.slots || [];
    const map = new Map<string, Slot[]>();
    for (const slot of slots) {
      const list = map.get(slot.date) || [];
      list.push(slot);
      map.set(slot.date, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "처리 실패");
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = () =>
    run(async () => {
      const res = await fetch("/api/marshals/plans", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          amSlotsPerDay: Number(amSlots),
          pmSlotsPerDay: Number(pmSlots),
          startRotationOrder: startOrder ? Number(startOrder) : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "설정 저장 실패");
    });

  const generate = (replace: boolean) =>
    run(async () => {
      if (replace && !window.confirm("기존 DRAFT 월표를 덮어씁니다. 벌당/대타/수동 슬롯도 사라집니다.")) {
        return;
      }
      const res = await fetch("/api/marshals/plans/generate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          amSlotsPerDay: Number(amSlots),
          pmSlotsPerDay: Number(pmSlots),
          startRotationOrder: startOrder ? Number(startOrder) : undefined,
          replace,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "생성 실패");
    });

  const finalize = () =>
    run(async () => {
      if (!data?.plan?.id) return;
      if (!window.confirm("이 월표를 FINALIZED 할까요? 일반 재생성은 더 이상 할 수 없습니다.")) {
        return;
      }
      const res = await fetch(`/api/marshals/plans/${data.plan.id}/finalize`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "마감 실패");
    });

  const addPenalty = () =>
    run(async () => {
      const res = await fetch("/api/marshals/penalties", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          date: penaltyDate,
          caddyId: Number(penaltyCaddyId),
          shift: penaltyShift,
          reason: penaltyReason,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "벌당 추가 실패");
      setPenaltyReason("");
    });

  const replaceSlot = () =>
    run(async () => {
      if (!data?.plan?.id || !subSlotId) return;
      const res = await fetch(
        `/api/marshals/plans/${data.plan.id}/slots/${subSlotId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caddyId: Number(subCaddyId),
            note: subNote,
            asSubstitute: true,
            applyCredit,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "교체 실패");
      setSubSlotId(null);
      setSubCaddyId("");
      setSubNote("");
      setApplyCredit(false);
    });

  const addCredit = (profileId: number) =>
    run(async () => {
      const res = await fetch("/api/marshals/credits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marshalProfileId: profileId,
          delta: 1,
          reason: "대타 보정",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "보정 추가 실패");
    });

  const cancelCredit = (creditId: number) =>
    run(async () => {
      const res = await fetch("/api/marshals/credits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditId, delta: -1 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "보정 취소 실패");
    });

  const finalized = data?.plan?.status === "FINALIZED";

  return (
    <div className="vh-page">
      <div className="vh-page-head">
        <h1>마샬 월표</h1>
        <p>
          순번을 이어서 돌립니다. 일반 휴무는 건너뛰지 않고 경고만 표시합니다.
          당일 투영은 다음 단계입니다.
        </p>
      </div>
      <MarshalManageNav />

      <form
        className="ui-card"
        style={{ padding: 16, marginBottom: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void saveSettings();
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="연"
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            style={{ width: 88 }}
          />
          <input
            aria-label="월"
            type="number"
            min={1}
            max={12}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            style={{ width: 72 }}
          />
          <input
            aria-label="시작 순번"
            type="number"
            min={1}
            placeholder="시작 순번"
            value={startOrder}
            onChange={(e) => setStartOrder(e.target.value)}
            style={{ width: 110 }}
          />
          <input
            aria-label="조출 인원"
            type="number"
            min={0}
            value={amSlots}
            onChange={(e) => setAmSlots(e.target.value)}
            style={{ width: 88 }}
          />
          <input
            aria-label="후출 인원"
            type="number"
            min={0}
            value={pmSlots}
            onChange={(e) => setPmSlots(e.target.value)}
            style={{ width: 88 }}
          />
          <button type="submit" className="ui-btn" disabled={busy || finalized}>
            설정 저장
          </button>
          <button
            type="button"
            className="ui-btn"
            disabled={busy || finalized}
            onClick={() => void generate(Boolean(data?.plan?.slots.length))}
          >
            자동생성
          </button>
          <button
            type="button"
            className="ui-btn"
            disabled={busy || !data?.plan?.id || finalized}
            onClick={() => void finalize()}
          >
            FINALIZE
          </button>
        </div>
        <p style={{ margin: "8px 0 0", color: "var(--vh-ink-soft)" }}>
          상태 {data?.plan?.status || "없음"} · 다음 순번{" "}
          {data?.plan?.nextRotationOrder ?? "—"}
          {data?.suggestedStartRotationOrder != null && !data.plan
            ? ` · 이전달 next ${data.suggestedStartRotationOrder}`
            : ""}
        </p>
      </form>

      {error && (
        <p className="vh-auth-error" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      <section className="ui-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>벌당</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            aria-label="벌당 날짜"
            type="date"
            value={penaltyDate}
            onChange={(e) => setPenaltyDate(e.target.value)}
          />
          <select
            aria-label="벌당 마샬"
            value={penaltyCaddyId}
            onChange={(e) => setPenaltyCaddyId(e.target.value)}
          >
            <option value="">마샬 선택</option>
            {(data?.members || []).map((m) => (
              <option key={m.profileId} value={m.caddyId}>
                {m.rotationOrder} {m.name}
              </option>
            ))}
          </select>
          <select
            aria-label="벌당 시프트"
            value={penaltyShift}
            onChange={(e) => setPenaltyShift(e.target.value)}
          >
            <option value="AM">조출</option>
            <option value="PM">후출</option>
          </select>
          <input
            aria-label="벌당 사유"
            placeholder="사유"
            value={penaltyReason}
            onChange={(e) => setPenaltyReason(e.target.value)}
          />
          <button
            type="button"
            className="ui-btn"
            disabled={busy || finalized || !penaltyDate || !penaltyCaddyId || !penaltyReason}
            onClick={() => void addPenalty()}
          >
            벌당 추가
          </button>
        </div>
        <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>
          {(data?.plan?.penalties || []).map((row) => (
            <li key={row.id}>
              {row.date} {shiftLabel(row.shift)} {row.caddy.name} · {row.reason}
            </li>
          ))}
        </ul>
      </section>

      <section className="ui-card" style={{ padding: 16, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>대타 보정</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {(data?.creditRemaining || []).map((row) => (
            <li key={row.profileId}>
              {row.name} 잔여 {row.remaining}{" "}
              <button
                type="button"
                className="ui-btn"
                disabled={busy}
                onClick={() => void addCredit(row.profileId)}
              >
                +1
              </button>
            </li>
          ))}
        </ul>
        {(data?.credits || []).length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {data!.credits.map((row) => (
              <li key={row.id}>
                {row.caddy.name} {row.reason || "보정"}{" "}
                <button
                  type="button"
                  className="ui-btn"
                  disabled={busy}
                  onClick={() => void cancelCredit(row.id)}
                >
                  -1
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {subSlotId != null && (
        <section className="ui-card" style={{ padding: 16, marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>슬롯 대타</h2>
          <select
            aria-label="대타 마샬"
            value={subCaddyId}
            onChange={(e) => setSubCaddyId(e.target.value)}
          >
            <option value="">마샬 선택</option>
            {(data?.members || []).map((m) => (
              <option key={m.profileId} value={m.caddyId}>
                {m.rotationOrder} {m.name}
              </option>
            ))}
          </select>
          <input
            aria-label="대타 메모"
            placeholder="사유"
            value={subNote}
            onChange={(e) => setSubNote(e.target.value)}
            style={{ marginLeft: 8 }}
          />
          <label style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={applyCredit}
              onChange={(e) => setApplyCredit(e.target.checked)}
            />{" "}
            대타 보정 적용
          </label>
          <button
            type="button"
            className="ui-btn"
            disabled={busy || !subCaddyId}
            onClick={() => void replaceSlot()}
          >
            저장
          </button>
        </section>
      )}

      {days.map(([date, slots]) => (
        <article key={date} className="ui-card" style={{ padding: 12, marginBottom: 10 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>{date}</h3>
          {(["AM", "PM"] as const).map((shift) => {
            const lane = slots
              .filter((s) => s.shift === shift)
              .sort((a, b) => a.slotIndex - b.slotIndex);
            if (lane.length === 0) return null;
            return (
              <div key={shift} style={{ marginBottom: 8 }}>
                <strong>{shiftLabel(shift)}</strong>
                <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {lane.map((slot) => (
                    <li key={slot.id}>
                      {slot.caddy.name}{" "}
                      <span>{sourceLabel(slot.source)}</span>
                      {slot.warning ? ` · ${slot.warning}` : ""}
                      {slot.originalCaddy ? ` · 원 ${slot.originalCaddy.name}` : ""}{" "}
                      <button
                        type="button"
                        className="ui-btn"
                        disabled={busy}
                        onClick={() => setSubSlotId(slot.id)}
                      >
                        교체
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </article>
      ))}
    </div>
  );
}
