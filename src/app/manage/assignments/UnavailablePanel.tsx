"use client";

import { useState } from "react";
import type { UnavailablePanelGroup } from "@/lib/assignmentBoardDirectEdit";

export function UnavailablePanel({
  groups,
}: {
  groups: UnavailablePanelGroup[];
}) {
  const [open, setOpen] = useState(true);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <aside className="ops-unavail" aria-label="오늘 비가용">
      <button
        type="button"
        className="ops-unavail-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
