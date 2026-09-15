import type { DailyStaffingSummary } from "@/lib/dailyStaffingSummary";
import { formatDailyStaffingCardModel } from "@/lib/dailyStaffingSummary";

export function DailyStaffingSummaryCard({
  summary,
}: {
  summary: DailyStaffingSummary;
}) {
  const model = formatDailyStaffingCardModel(summary);
  return (
    <section
      className="ops-staffing-card"
      data-staffing-card="1"
      data-staffing-required-source={summary.required.source}
      data-staffing-gap={summary.gap.kind}
      data-staffing-board-status={summary.boardStatus}
      aria-label={model.title}
    >
      <div className="ops-staffing-title">{model.title}</div>
      <div className="ops-staffing-grid">
        {model.rows.map((row) => (
          <div key={row.key}>
            <div
              className={`ops-staffing-row${row.tone ? ` is-${row.tone}` : ""}`}
              data-staffing-row={row.key}
            >
              <span className="ops-staffing-k">{row.label}</span>
              <span className="ops-staffing-vwrap">
                <span className="ops-staffing-v">{row.value}</span>
                {row.badge ? (
                  <span
                    className={`ops-staffing-badge is-${row.badge}`}
                    data-staffing-badge={row.badge}
                  >
                    {row.badge === "current" ? "현재 배치" : "예상"}
                  </span>
                ) : null}
              </span>
            </div>
            {row.key === "reservation" && model.shiftLine ? (
              <div className="ops-staffing-shifts" data-staffing-shifts="1">
                {model.shiftLine}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
