"use client";

import { useState, type ReactNode } from "react";
import type { UnavailablePanelGroup } from "@/lib/assignmentBoardDirectEdit";
import { unavailablePanelTotal } from "@/lib/assignmentBoardDirectEdit";
import {
  compactPeopleNames,
  filledDutySlots,
  filledMarshalSlots,
  opsSpecialDutyChips,
  opsSpecialSupportBlocks,
  opsStatusCountChips,
  type OpsSpecialDutyGroup,
  type OpsSpecialSupportItem,
} from "@/lib/opsStatusPanelView";
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

function CompactPeople({ people }: { people: UnavailableBoardPerson[] }) {
  if (people.length === 0) {
    return <span className="ops-unavail-blank">없음</span>;
  }
  return (
    <div className="ops-unavail-names">
      {people.map((person, index) => (
        <span key={person.caddyId} className="ops-unavail-person">
          {index > 0 ? " · " : null}
          <span className="ops-unavail-name">{person.name}</span>
          {person.badges.map((badge) => (
            <span key={badge} className="ops-unavail-badge">
              {badge}
            </span>
          ))}
        </span>
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
          <CompactPeople people={block.people} />
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
          <CompactPeople people={slot.people} />
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

function OpsSection({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="ops-unavail-sec"
      open={open}
      onToggle={(event) => {
        setOpen((event.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary>
        {title}
        {count != null ? (
          <span className="ops-unavail-sec-count">{count}</span>
        ) : null}
      </summary>
      {children}
    </details>
  );
}

export function UnavailablePanel({
  groups,
  sources,
  summary,
  open,
  sheetOpen = false,
  onToggle,
  onCollapse,
  specialDutyGroups = [],
  specialSupportItems = [],
}: {
  groups: UnavailablePanelGroup[];
  sources?: UnavailableBoardSources | null;
  summary?: OpsStatusSummary | null;
  open: boolean;
  sheetOpen?: boolean;
  onToggle: () => void;
  onCollapse?: () => void;
  specialDutyGroups?: OpsSpecialDutyGroup[];
  specialSupportItems?: OpsSpecialSupportItem[];
}) {
  const view = buildUnavailableBoardView(groups, sources);
  const stats = {
    ...(summary || pickOpsStatusSummary(null, groups, view)),
    sick: view.sick.length,
    absent: view.absent.length,
  };
  const total = unavailablePanelTotal(groups);
  const countChips = opsStatusCountChips(view, stats.off);
  const dutySlots = filledDutySlots(view.dutySlots);
  const marshalSlots = filledMarshalSlots(view.marshalSlots);
  const specialChips = opsSpecialDutyChips(specialDutyGroups);
  const supportBlocks = opsSpecialSupportBlocks(specialSupportItems);
  const supportTotal = supportBlocks.reduce((n, block) => n + block.count, 0);
  const specialTotal = specialChips.reduce((n, chip) => n + chip.count, 0);
  const hasHealth = view.sick.length > 0 || view.absent.length > 0;

  return (
    <aside
      className={`ops-unavail${open ? " is-open" : ""}${
        sheetOpen ? " is-mobile-open" : ""
      }`}
      aria-label="오늘 운영현황"
      data-ops-status-panel="1"
    >
      <div className="ops-unavail-head">
        <h2>오늘 운영현황</h2>
        <div className="ops-unavail-head-actions">
          <button
            type="button"
            className="ops-unavail-collapse"
            onClick={onCollapse || onToggle}
          >
            접기
          </button>
          <button
            type="button"
            className="ops-unavail-close"
            aria-expanded={sheetOpen}
            onClick={onToggle}
          >
            닫기
          </button>
        </div>
      </div>
      <div className="ops-unavail-hero">
        <span>비가용</span>
        <b>{total}명</b>
      </div>
      {countChips.length > 0 ? (
        <div className="ops-unavail-chips" aria-label="비가용 구분">
          {countChips.map((chip) => (
            <span key={chip.key} className="ops-unavail-count-chip">
              {chip.label} {chip.count}
            </span>
          ))}
        </div>
      ) : null}
      <SummaryStrip summary={stats} />
      <div className="ops-unavail-body">
        {view.offTeams.length > 0 ? (
          <OpsSection title="휴무" count={stats.off ?? undefined}>
            <TeamBlocks
              blocks={view.offTeams}
              className="ops-unavail-off-grid"
            />
          </OpsSection>
        ) : null}
        {hasHealth ? (
          <OpsSection title="병가 / 결근">
            {view.sick.length > 0 ? (
              <div className="ops-unavail-row">
                <span className="ops-unavail-k">병가</span>
                <CompactPeople people={view.sick} />
              </div>
            ) : null}
            {view.absent.length > 0 ? (
              <div className="ops-unavail-row">
                <span className="ops-unavail-k">결근</span>
                <CompactPeople people={view.absent} />
              </div>
            ) : null}
          </OpsSection>
        ) : null}
        <OpsSection title="당번" defaultOpen>
          <SlotBlocks slots={dutySlots} />
        </OpsSection>
        <OpsSection title="마샬" defaultOpen>
          <SlotBlocks slots={marshalSlots} />
        </OpsSection>
        <OpsSection title="조장" count={view.leaders.length || undefined}>
          <CompactPeople people={view.leaders} />
        </OpsSection>
        {view.specialBands.length > 0 ? (
          <OpsSection title="특수반">
            <TeamBlocks blocks={view.specialBands} />
          </OpsSection>
        ) : null}
        {view.other.length > 0 ? (
          <OpsSection title="기타" count={view.other.length}>
            <CompactPeople people={view.other} />
          </OpsSection>
        ) : null}
        {view.conflicts.length > 0 ? (
          <OpsSection title="상태/역할 충돌" count={view.conflicts.length}>
            <div className="ops-unavail-names">
              {view.conflicts.map((row) => (
                <span key={row.caddyId} className="ops-unavail-person">
                  <span className="ops-unavail-name">{row.name}</span>
                  <span className="ops-unavail-badge">
                    {row.status}·{row.role}
                  </span>
                </span>
              ))}
            </div>
          </OpsSection>
        ) : null}
        <OpsSection title="특수근무" count={specialTotal}>
          <div className="ops-unavail-kind-grid">
            {specialChips.map((chip) => (
              <details key={chip.kind} className="ops-unavail-kind">
                <summary>
                  <span>{chip.label}</span>
                  <b>{chip.count}</b>
                </summary>
                <p className="ops-unavail-kind-names">
                  {chip.names.length
                    ? compactPeopleNames(chip.names.map((name) => ({ name })))
                    : "없음"}
                </p>
              </details>
            ))}
          </div>
        </OpsSection>
        <OpsSection title="지원근무" count={supportTotal}>
          <div className="ops-unavail-kind-grid">
            {supportBlocks.map((block) => (
              <details key={block.kind} className="ops-unavail-kind">
                <summary>
                  <span>{block.label}</span>
                  <b>{block.count}</b>
                </summary>
                {block.people.length === 0 ? (
                  <p className="ops-unavail-kind-names">없음</p>
                ) : (
                  <div className="ops-unavail-support-list">
                    {block.people.map((person) => (
                      <div
                        key={`${block.kind}-${person.caddyId}`}
                        className="ops-unavail-support-row"
                      >
                        <span className="ops-unavail-name">{person.name}</span>
                        <span className="ops-unavail-badge">
                          {person.kindBadge}
                        </span>
                        <span className="ops-unavail-badge">
                          {person.patternBadge}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            ))}
          </div>
        </OpsSection>
      </div>
    </aside>
  );
}
