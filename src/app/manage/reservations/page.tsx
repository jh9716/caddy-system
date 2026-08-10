"use client";

import { useMemo, useState } from "react";
import type {
  ParsedReservation,
  ReservationParseResult,
  ShiftPart,
} from "@/lib/reservationParser";

type PreviewResponse = ReservationParseResult & {
  filename?: string;
  error?: string;
};

export default function ManageReservationsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [defaultDate, setDefaultDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedCourse, setSelectedCourse] = useState<string>("ALL");
  const [selectedShift, setSelectedShift] = useState<string>("ALL");
  const [showReviewOnly, setShowReviewOnly] = useState(false);

  async function onPreview() {
    if (!file) {
      setError("파일을 선택하세요.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (defaultDate) form.append("defaultDate", defaultDate);
      const res = await fetch("/api/reservations/preview", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = (await res.json()) as PreviewResponse;
      if (!res.ok) {
        setResult(null);
        setError(data.error || "파싱 실패");
        return;
      }
      setResult(data);
      const firstDate = data.summary.byDate[0]?.date || "";
      setSelectedDate(firstDate);
      setSelectedCourse("ALL");
      setSelectedShift("ALL");
      setShowReviewOnly(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "요청 실패");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const dateOptions = result?.summary.byDate.map((d) => d.date) || [];

  const daySummary = useMemo(() => {
    if (!result || !selectedDate) return null;
    return result.summary.byDate.find((d) => d.date === selectedDate) || null;
  }, [result, selectedDate]);

  const filteredRows = useMemo(() => {
    if (!result) return [] as ParsedReservation[];
    let rows = showReviewOnly ? result.needsReview : result.reservations;
    if (selectedDate) rows = rows.filter((r) => r.date === selectedDate || !r.date);
    if (selectedCourse !== "ALL") {
      rows = rows.filter((r) => r.course === selectedCourse);
    }
    if (selectedShift !== "ALL") {
      rows = rows.filter((r) => r.shift === selectedShift);
    }
    return rows;
  }, [result, selectedDate, selectedCourse, selectedShift, showReviewOnly]);

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 1100 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22 }}>예약표 파싱 (미리보기)</h1>
        <p style={{ margin: "6px 0 0", color: "#64748b", fontSize: 14 }}>
          XLSX/XLS 업로드 → 날짜·코스·부·티타임 표준화. DB 저장·자동배치 없음.
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
        <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
          예약 엑셀 파일
          <input
            type="file"
            accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 14, maxWidth: 240 }}>
          기본 날짜 (시트에 날짜 없을 때)
          <input
            type="date"
            value={defaultDate}
            onChange={(e) => setDefaultDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={onPreview}
          disabled={loading || !file}
          style={{
            width: "fit-content",
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid #0f172a",
            background: loading ? "#94a3b8" : "#0f172a",
            color: "#fff",
            cursor: loading || !file ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "파싱 중…" : "미리보기"}
        </button>
        {error && <div style={{ color: "#b91c1c", fontSize: 14 }}>{error}</div>}
      </div>

      {result && (
        <>
          <div
            style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            }}
          >
            <Stat label="파일" value={result.filename || "-"} />
            <Stat label="유효 팀" value={String(result.summary.totals.teams)} />
            <Stat label="needsReview" value={String(result.summary.totals.needsReview)} />
            <Stat label="중복" value={String(result.summary.totals.duplicates)} />
            <Stat label="시트" value={String(result.summary.totals.sheets)} />
          </div>

          {result.warnings.length > 0 && (
            <div style={{ fontSize: 13, color: "#b45309" }}>
              {result.warnings.map((w) => (
                <div key={w}>⚠ {w}</div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
            <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
              날짜
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ minWidth: 140, padding: 6 }}
              >
                {dateOptions.length === 0 && <option value="">(없음)</option>}
                {dateOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
              코스
              <select
                value={selectedCourse}
                onChange={(e) => setSelectedCourse(e.target.value)}
                style={{ minWidth: 120, padding: 6 }}
              >
                <option value="ALL">전체</option>
                <option value="VERTHILL">베르힐</option>
                <option value="SKY">스카이</option>
                <option value="OCEAN">오션</option>
                <option value="LAKE">레이크</option>
              </select>
            </label>
            <label style={{ fontSize: 13, display: "grid", gap: 4 }}>
              부
              <select
                value={selectedShift}
                onChange={(e) => setSelectedShift(e.target.value)}
                style={{ minWidth: 100, padding: 6 }}
              >
                <option value="ALL">전체</option>
                <option value="1부">1부</option>
                <option value="2부">2부</option>
                <option value="3부">3부</option>
              </select>
            </label>
            <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={showReviewOnly}
                onChange={(e) => setShowReviewOnly(e.target.checked)}
              />
              needsReview만
            </label>
          </div>

          {daySummary && (
            <div
              style={{
                padding: 12,
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                background: "#f8fafc",
                fontSize: 14,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                {daySummary.date} · 총 {daySummary.totalTeams}팀
              </div>
              <div style={{ marginBottom: 8 }}>
                부별: 1부 {daySummary.byShift["1부"]} / 2부 {daySummary.byShift["2부"]} / 3부{" "}
                {daySummary.byShift["3부"]}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {daySummary.byCourse.map((c) => (
                  <div key={c.course}>
                    <strong>{c.courseLabel}</strong> {c.totalTeams}팀 —{" "}
                    {(["1부", "2부", "3부"] as ShiftPart[])
                      .map((s) => `${s} ${c.byShift[s]}`)
                      .join(" · ")}
                  </div>
                ))}
              </div>
            </div>
          )}

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
                  {[
                    "날짜",
                    "코스",
                    "부",
                    "티타임",
                    "팀/예약자",
                    "홀",
                    "출발홀",
                    "시트",
                    "행",
                    "상태",
                  ].map((h) => (
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
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ padding: 12, color: "#64748b" }}>
                      표시할 행이 없습니다.
                    </td>
                  </tr>
                )}
                {filteredRows.map((r) => (
                  <tr
                    key={`${r.sourceSheet}-${r.rawRowIndex}-${r.teeTime}-${r.teamName}`}
                    style={{
                      background: r.needsReview ? "#fff7ed" : undefined,
                    }}
                  >
                    <td style={td}>{r.date || "-"}</td>
                    <td style={td}>{r.courseLabel}</td>
                    <td style={td}>{r.shift}</td>
                    <td style={td}>{r.teeTime || "-"}</td>
                    <td style={td}>{r.teamName || "-"}</td>
                    <td style={td}>{r.hole ?? "-"}</td>
                    <td style={td}>{r.startingHole ?? "-"}</td>
                    <td style={td}>{r.sourceSheet}</td>
                    <td style={td}>{r.rawRowIndex}</td>
                    <td style={td}>
                      {r.needsReview
                        ? r.reviewReasons.join(", ")
                        : r.isDuplicate
                          ? "중복"
                          : "OK"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      <div style={{ fontWeight: 700, marginTop: 2, wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

const td: React.CSSProperties = {
  padding: "7px 6px",
  borderBottom: "1px solid #f1f5f9",
  whiteSpace: "nowrap",
};
