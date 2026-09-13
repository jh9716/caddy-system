"use client";

import type { UnavailablePanelGroup } from "@/lib/assignmentBoardDirectEdit";
import {
  buildUnavailableBoardView,
  pickOpsStatusSummary,
  type OpsStatusSummary,
  type UnavailableBoardPerson,
  type UnavailableBoardSources,
  type UnavailableSlotBlock,
  type UnavailableTeamBlock,
} from "@/lib/unavailablePanelView";

function formatCount(value: number | null | undefined): string {
  return value == null ? "—" : String(value);
}

function PersonPill({ person }: { person: UnavailableBoardPerson }) {
  return (
    <span className="ops-unavail-pill">
      <span className="ops-unavail-name">{person.name}</span>
      {person.badges.map((badge) => (
        <span key={badge} className="ops-unavail-badge">
          {badge}
        </span>
      ))}
    </span>
  );
}

function PersonFlow({ people }: { people: UnavailableBoardPerson[] }) {
  if (people.length === 0) {
    return <span className="ops-unavail-blank">—</span>;
  }
  return (
    <div className="ops-unavail-pills">
      {people.map((person) => (
        <PersonPill key={person.caddyId} person={person} />
      ))}
    </div>
  );
}

function TeamBlocks({
  blocks,
  className,
}: {
  blocks: UnavailableTeamBlock[];
  className?: string;
}) {
  return (
    <div className={className}>
      {blocks.map((block) => (
        <div key={block.team} className="ops-unavail-row">
          <span className="ops-unavail-k">{block.team}</span>
          <PersonFlow people={block.people} />
        </div>
      ))}
    </div>
  );
}

function SlotBlocks({ slots }: { slots: UnavailableSlotBlock[] }) {
  return (
    <div className="ops-unavail-slots">
      {slots.map((slot) => (
        <div key={slot.label} className="ops-unavail-row">
          <span className="ops-unavail-k">{slot.label}</span>
          <PersonFlow people={slot.people} />
        </div>
      ))}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: OpsStatusSummary }) {
  return (
    <div className="ops-unavail-summary" aria-label="오늘 운영 요약">
      <span className="ops-unavail-stat">
        <b>{formatCount(summary.employed)}</b>
        <span>재직</span>
      </span>
      <span className="ops-unavail-stat">
        <b>{formatCount(summary.off)}</b>
        <span>휴무</span>
      </span>
      <span className="ops-unavail-stat is-final">
        <b>{formatCount(summary.finalAvailable)}</b>
        <span>최종가용</span>
      </span>
      <span className="ops-unavail-stat">
        <b>{formatCount(summary.sick)}</b>
        <span>병가</span>
      </span>
      <span className="ops-unavail-stat">
        <b>{formatCount(summary.absent)}</b>
        <span>결근</span>
      </span>
    </div>
  );
}

export function UnavailablePanel({
  groups,
  sources,
  summary,
  open,
  sheetOpen = false,
  onToggle,
}: {
  groups: UnavailablePanelGroup[];
  sources?: UnavailableBoardSources | null;
  summary?: OpsStatusSummary | null;
  open: boolean;
  sheetOpen?: boolean;
  onToggle: () => void;
}) {
  const view = buildUnavailableBoardView(groups, sources);
  const stats = {
    ...(summary || pickOpsStatusSummary(null, groups, view)),
    sick: view.sick.length,
    absent: view.absent.length,
  };
  const hasHealth = view.sick.length > 0 || view.absent.length > 0;
  return (
    <aside
      className={`ops-unavail${open ? " is-open" : ""}${
        sheetOpen ? " is-mobile-open" : ""
      }`}
      aria-label="오늘 운영현황"
    >
      <div className="ops-unavail-head">
        <h2>오늘 운영현황</h2>
        <button
          type="button"
          className="ops-unavail-close"
          aria-expanded={sheetOpen}
          onClick={onToggle}
        >
          닫기
        </button>
      </div>
      <SummaryStrip summary={stats} />
      <div className="ops-unavail-body">
        {view.total === 0 ? (
          <p className="ops-unavail-empty">표시할 비가용 캐디가 없습니다.</p>
        ) : (
          <>
            {view.offTeams.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>휴무</h3>
                <TeamBlocks
                  blocks={view.offTeams}
                  className="ops-unavail-off-grid"
                />
              </section>
            ) : null}
            {hasHealth ? (
              <section className="ops-unavail-sec">
                <h3>병가 / 결근</h3>
                {view.sick.length > 0 ? (
                  <div className="ops-unavail-row">
                    <span className="ops-unavail-k">병가</span>
                    <PersonFlow people={view.sick} />
                  </div>
                ) : null}
                {view.absent.length > 0 ? (
                  <div className="ops-unavail-row">
                    <span className="ops-unavail-k">결근</span>
                    <PersonFlow people={view.absent} />
                  </div>
                ) : null}
              </section>
            ) : null}
            {view.dutySlots.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>당번</h3>
                <SlotBlocks slots={view.dutySlots} />
              </section>
            ) : null}
            {view.marshalSlots.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>마샬</h3>
                <SlotBlocks slots={view.marshalSlots} />
              </section>
            ) : null}
            {view.leaders.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>조장</h3>
                <PersonFlow people={view.leaders} />
              </section>
            ) : null}
            {view.specialBands.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>특수반</h3>
                <TeamBlocks blocks={view.specialBands} />
              </section>
            ) : null}
            {view.other.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>기타</h3>
                <PersonFlow people={view.other} />
              </section>
            ) : null}
            {view.conflicts.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>상태/역할 충돌</h3>
                <div className="ops-unavail-pills">
                  {view.conflicts.map((row) => (
                    <span key={row.caddyId} className="ops-unavail-pill">
                      <span className="ops-unavail-name">{row.name}</span>
                      <span className="ops-unavail-badge">
                        {row.status}·{row.role}
                      </span>
                    </span>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
