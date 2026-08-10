"use client";

import { useMemo, useState } from "react";
import type { AutoAssignResultV1 } from "@/lib/autoAssignEngine";

type PreviewResponse = AutoAssignResultV1 & {
  error?: string;
  mode?: string;
  filename?: string;
  reservationParse?: {
    summary: { totals: { teams: number; needsReview: number } };
    warnings: string[];
    needsReviewCount: number;
  };
  availabilityCounts?: {
    available: number;
    special: number;
    excluded: number;
  };
};

type Tab =
  | "assigned"
  | "fiftyFour"
  | "oneThree"
  | "oneTwo"
  | "regular"
  | "unassigned"
  | "unused"
  | "special"
  | "specialUnassigned";

export default function AutoAssignPreviewPage() {
  const [date, setDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [tab, setTab] = useState<Tab>("assigned");
  const [shiftFilter, setShiftFilter] = useState<string>("ALL");

  async function onPreview() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    if (!file) {
      setError("예약 엑셀 파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("date", date);
      form.append("file", file);
      const res = await fetch("/api/assignments/preview", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = (await res.json()) as PreviewResponse;
      if (!res.ok) {
        setResult(null);
        setError(data.error || "미리보기 실패");
        return;
      }
      setResult(data);
      setTab("assigned");
      setShiftFilter("ALL");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "요청 실패");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const assignedRows = useMemo(() => {
    if (!result) return [];
    if (shiftFilter === "ALL") return result.assignments;
    return result.assignments.filter((a) => a.shift === shiftFilter);
  }, [result, shiftFilter]);

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 1200 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>자동배치 미리보기</h1>
        <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 14 }}>
          우선순위: 54홀 → 1·3부 → 1·2부 → 일반 순번. DB에 Assignment를 쓰지 않습니다.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gap: 10,
          padding: 14,
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          background: "#fff",
        }}
      >
        <label style={{ display: "grid", gap: 4, fontSize: 14, maxWidth: 240 }}>
          날짜
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
          예약 엑셀 (XLSX/XLS)
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <button
          type="button"
          onClick={onPreview}
          disabled={loading || !date || !file}
          style={{
            width: "fit-content",
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #0f172a",
            background: loading ? "#94a3b8" : "#0f172a",
            color: "#fff",
            cursor: loading || !date || !file ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "계산 중…" : "배치 미리보기"}
        </button>
        {error && <div style={{ color: "#b91c1c", fontSize: 14 }}>{error}</div>}
      </div>

      {result && (
        <>
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            }}
          >
            <Stat label="배치됨" value={String(result.meta.assignedCount)} />
            <Stat
              label="54홀 배치"
              value={String(result.meta.fiftyFourHoleAssignedCaddyCount ?? 0)}
            />
            <Stat
              label="1·3부 배치"
              value={String(result.meta.oneThreeAssignedCaddyCount ?? 0)}
            />
            <Stat
              label="1·2부 배치"
              value={String(result.meta.oneTwoAssignedCaddyCount ?? 0)}
            />
            <Stat
              label="special review"
              value={String(
                (result.meta.fiftyFourHoleUnassignedCount ?? 0) +
                  (result.meta.oneThreeUnassignedCount ?? 0) +
                  (result.meta.oneTwoUnassignedCount ?? 0)
              )}
            />
            <Stat label="미배치 예약" value={String(result.meta.unassignedCount)} />
            <Stat label="미사용 캐디" value={String(result.meta.unusedCount)} />
            <Stat label="가용" value={String(result.meta.availableCount)} />
            <Stat
              label="1/2/3부 배치"
              value={`${result.meta.byShift["1부"].assigned}/${result.meta.byShift["2부"].assigned}/${result.meta.byShift["3부"].assigned}`}
            />
          </div>

          {result.reservationParse && (
            <div style={{ fontSize: 13, color: "#475569" }}>
              파일 {result.filename || "-"} · 파싱 유효팀{" "}
              {result.reservationParse.summary.totals.teams} · needsReview{" "}
              {result.reservationParse.needsReviewCount}
              {result.availabilityCounts && (
                <>
                  {" "}
                  · DB가용 {result.availabilityCounts.available} / 제외{" "}
                  {result.availabilityCounts.excluded}
                </>
              )}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(
              [
                ["assigned", "전체 배치"],
                ["fiftyFour", "54홀"],
                ["oneThree", "1·3부"],
                ["oneTwo", "1·2부"],
                ["regular", "일반순번"],
                ["unassigned", "미배치 예약"],
                ["unused", "미사용 캐디"],
                ["special", "special"],
                ["specialUnassigned", "special review"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #cbd5e1",
                  background: tab === key ? "#0f172a" : "#fff",
                  color: tab === key ? "#fff" : "#0f172a",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {label}
              </button>
            ))}
            {tab === "assigned" && (
              <select
                value={shiftFilter}
                onChange={(e) => setShiftFilter(e.target.value)}
                style={{ padding: 6, marginLeft: 8 }}
              >
                <option value="ALL">부 전체</option>
                <option value="1부">1부</option>
                <option value="2부">2부</option>
                <option value="3부">3부</option>
              </select>
            )}
          </div>

          {(tab === "assigned" ||
            tab === "fiftyFour" ||
            tab === "oneThree" ||
            tab === "oneTwo" ||
            tab === "regular") && (
            <Table
              headers={[
                "구분",
                "부",
                "티타임",
                "코스",
                "예약",
                "캐디",
                "조",
                "순번idx",
                "reason",
              ]}
              rows={(tab === "assigned"
                ? assignedRows
                : tab === "fiftyFour"
                  ? result.fiftyFourHoleAssignments || []
                  : tab === "oneThree"
                    ? result.oneThreeAssignments || []
                    : tab === "oneTwo"
                      ? result.oneTwoAssignments || []
                      : result.regularAssignments || []
              )
                .filter((a) =>
                  tab === "assigned" && shiftFilter !== "ALL"
                    ? a.shift === shiftFilter
                    : true
                )
                .map((a) => [
                  a.kind === "fiftyFourHole"
                    ? "54홀"
                    : a.kind === "oneThree"
                      ? "1·3부"
                      : a.kind === "oneTwo"
                        ? "1·2부"
                        : "일반",
                  a.shift,
                  a.reservation.teeTime,
                  a.reservation.courseLabel || a.reservation.course,
                  a.reservation.teamName || "-",
                  `${a.caddy.name}(#${a.caddy.id})`,
                  a.caddy.team,
                  String(a.sequenceIndex),
                  a.reason,
                ])}
            />
          )}

          {tab === "unassigned" && (
            <Table
              headers={["부", "티타임", "코스", "예약", "사유"]}
              rows={result.unassignedReservations.map((u) => [
                String(u.reservation.shift || "-"),
                u.reservation.teeTime || "-",
                u.reservation.courseLabel || u.reservation.course || "-",
                u.reservation.teamName || "-",
                u.reason,
              ])}
            />
          )}

          {tab === "unused" && (
            <Table
              headers={["ID", "이름", "조", "teamOrder"]}
              rows={result.unusedCaddies.map((c) => [
                String(c.id),
                c.name,
                c.team,
                String(c.teamOrder),
              ])}
            />
          )}

          {tab === "special" && (
            <Table
              headers={["ID", "이름", "조", "teamOrder", "비고"]}
              rows={result.special.map((c) => [
                String(c.id),
                c.name,
                c.team,
                String(c.teamOrder),
                "v1 미배치",
              ])}
            />
          )}

          {tab === "specialUnassigned" && (
            <Table
              headers={["ID", "이름", "조", "reason", "review"]}
              rows={(result.specialUnassigned || []).map((u) => [
                String(u.caddy.id),
                u.caddy.name,
                u.caddy.team,
                u.reason,
                u.review ? "Y" : "N",
              ])}
            />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 10,
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
      <div style={{ fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
          background: "#fff",
        }}
      >
        <thead>
          <tr style={{ background: "#f1f5f9", textAlign: "left" }}>
            {headers.map((h) => (
              <th
                key={h}
                style={{ padding: "8px 6px", borderBottom: "1px solid #e2e8f0" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={headers.length}
                style={{ padding: 12, color: "#64748b" }}
              >
                없음
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  style={{
                    padding: "7px 6px",
                    borderBottom: "1px solid #f1f5f9",
                    whiteSpace: "nowrap",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
