"use client";

import type { UnavailablePanelGroup } from "@/lib/assignmentBoardDirectEdit";
import { unavailablePanelTotal } from "@/lib/assignmentBoardDirectEdit";

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
  const total = unavailablePanelTotal(groups);
  return (
    <aside
      className={`ops-unavail${open ? " is-open" : ""}${
        sheetOpen ? " is-mobile-open" : ""
      }`}
      aria-label="오늘 비가용"
    >
      <button
        type="button"
        className="ops-unavail-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        오늘 비가용 {total}명 {open ? "접기" : "펼치기"}
      </button>
      {open ? (
        <div className="ops-unavail-body">
          {groups.length === 0 ? (
            <p className="ops-unavail-empty">표시할 비가용 캐디가 없습니다.</p>
          ) : (
            groups.map((group) => (
              <section key={group.category} className="ops-unavail-group">
                <h3>
                  {group.category} {group.items.length}
                </h3>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.caddyId}>
                      <span className="ops-unavail-name">{item.name}</span>
                      <span className="ops-unavail-team">{item.team}</span>
                      <span className="ops-unavail-reason">{item.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      ) : null}
    </aside>
  );
}
