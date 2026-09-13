"use client";

import type { UnavailablePanelGroup } from "@/lib/assignmentBoardDirectEdit";
import {
  buildUnavailableBoardView,
  type UnavailableBoardPerson,
  type UnavailableSlotBlock,
  type UnavailableTeamBlock,
} from "@/lib/unavailablePanelView";

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

export function UnavailablePanel({
  groups,
  open,
  sheetOpen = false,
  onToggle,
}: {
  groups: UnavailablePanelGroup[];
  open: boolean;
  sheetOpen?: boolean;
  onToggle: () => void;
}) {
  const view = buildUnavailableBoardView(groups);
  return (
    <aside
      className={`ops-unavail${open ? " is-open" : ""}${
        sheetOpen ? " is-mobile-open" : ""
      }`}
      aria-label="오늘 비가용"
    >
      <div className="ops-unavail-head">
        <h2>오늘 비가용 {view.total}명</h2>
        <button
          type="button"
          className="ops-unavail-close"
          aria-expanded={sheetOpen}
          onClick={onToggle}
        >
          닫기
        </button>
      </div>
      <div className="ops-unavail-body">
        {view.total === 0 ? (
          <p className="ops-unavail-empty">표시할 비가용 캐디가 없습니다.</p>
        ) : (
          <>
            {view.offTeams.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  휴무{" "}
                  <em>
                    {view.offTeams.reduce((n, block) => n + block.people.length, 0)}
                  </em>
                </h3>
                <TeamBlocks
                  blocks={view.offTeams}
                  className="ops-unavail-off-grid"
                />
              </section>
            ) : null}
            {view.sick.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  병가 <em>{view.sick.length}</em>
                </h3>
                <PersonFlow people={view.sick} />
              </section>
            ) : null}
            {view.absent.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  결근 <em>{view.absent.length}</em>
                </h3>
                <PersonFlow people={view.absent} />
              </section>
            ) : null}
            {view.dutySlots.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  당번{" "}
                  <em>
                    {view.dutySlots.reduce((n, slot) => n + slot.people.length, 0)}
                  </em>
                </h3>
                <SlotBlocks slots={view.dutySlots} />
              </section>
            ) : null}
            {view.marshalSlots.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  마샬{" "}
                  <em>
                    {view.marshalSlots.reduce(
                      (n, slot) => n + slot.people.length,
                      0
                    )}
                  </em>
                </h3>
                <SlotBlocks slots={view.marshalSlots} />
              </section>
            ) : null}
            {view.leaders.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  조장 <em>{view.leaders.length}</em>
                </h3>
                <PersonFlow people={view.leaders} />
              </section>
            ) : null}
            {view.specialBands.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  특수반{" "}
                  <em>
                    {view.specialBands.reduce(
                      (n, block) => n + block.people.length,
                      0
                    )}
                  </em>
                </h3>
                <TeamBlocks blocks={view.specialBands} />
              </section>
            ) : null}
            {view.other.length > 0 ? (
              <section className="ops-unavail-sec">
                <h3>
                  기타 <em>{view.other.length}</em>
                </h3>
                <PersonFlow people={view.other} />
              </section>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
