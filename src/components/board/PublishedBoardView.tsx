"use client";

import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
  PublishedSpareV1,
} from "@/lib/dailyBoardPublished";
import {
  buildPublishedShiftBoard,
} from "@/lib/publishedBoardView";
import {
  COURSE_CODES,
  COURSE_LABELS,
  type ShiftPart,
} from "@/lib/reservationParser";
import { publishedBoardCss } from "@/components/board/publishedBoardCss";

function Marks({ row }: { row: PublishedPlacementV1 }) {
  const special = row.kind !== "regular" && row.kind !== "specialSupport";
  if (
    !row.twoWork &&
    !row.chageun &&
    !row.specialSupport &&
    !special &&
    !row.limousine &&
    !row.driving
  ) {
    return null;
  }
  return (
    <span className="bc-marks">
      {row.limousine ? <span className="bc-badge limo">리무진</span> : null}
      {row.driving ? <span className="bc-badge drive">드라이빙</span> : null}
      {row.twoWork ? <span className="bc-badge two">투</span> : null}
      {row.specialSupport ? (
        <span className="bc-badge support">지원</span>
      ) : null}
      {row.chageun ? (
        <span className="bc-badge call">찾근</span>
      ) : special && !row.driving ? (
        <span className="bc-special">S</span>
      ) : null}
    </span>
  );
}

function ReadOnlySlot({ row }: { row: PublishedPlacementV1 }) {
  return (
    <div className="bc-slot">
      <div className="bc-team">
        <span className="bc-team-name">{row.teamName || "팀"}</span>
        {row.houseRequest ? <span className="bc-badge house">하우스</span> : null}
        {row.limousine ? <span className="bc-badge limo">리무진</span> : null}
      </div>
      <div className="bc-caddy">
        <span className="bc-name">{row.caddyName}</span>
        {row.caddyTeam ? <span className="bc-affil">{row.caddyTeam}</span> : null}
        <Marks row={row} />
      </div>
      {row.locked ? <span className="lock-chip">LOCK</span> : null}
    </div>
  );
}

function SpareStrip({
  spare,
  shift,
}: {
  spare: PublishedSpareV1 | null;
  shift: ShiftPart;
}) {
  if (!spare || (!spare.spare1 && !spare.spare2)) return null;
  return (
    <div className="pub-spare" aria-label={`${shift} 스페어`}>
      <span className="pub-spare-label">{shift} 스페어</span>
      <span>{spare.spare1 ? spare.spare1.displayLabel : "—"}</span>
      <span>{spare.spare2 ? spare.spare2.displayLabel : "—"}</span>
    </div>
  );
}

export default function PublishedBoardView({
  payload,
  shift,
}: {
  payload: DailyBoardPublishedPayloadV1;
  shift: ShiftPart;
}) {
  const board = buildPublishedShiftBoard(payload, shift);
  const spare =
    payload.sparesByShift.find((s) => s.shift === shift) || null;
  const open = new Set(payload.openCourses);

  return (
    <div className="pub-board-root">
      <div className="ops-board-head-bar">
        <div className="ops-board-head">
          <div className="bh-time">시각</div>
          {COURSE_CODES.map((code) => (
            <div
              key={code}
              className={`bh-course${open.has(code) ? "" : " closed"}`}
            >
              {COURSE_LABELS[code]}
            </div>
          ))}
        </div>
      </div>
      <div className="ops-board-wrap has-sticky-head">
        <div className="ops-board" role="table" aria-label={`${shift} 배치표`}>
          {board.length === 0 ? (
            <div className="pub-empty-shift">이 부에 확정된 배치가 없습니다.</div>
          ) : (
            board.map((tr) => (
              <div key={tr.teeTime} className="ops-board-block">
                <div className="ops-board-row" role="row">
                  <div className="bc-time">{tr.teeTime || "—"}</div>
                  {COURSE_CODES.map((code) => {
                    const cell = tr.cells[code];
                    if (cell.kind === "closed") {
                      return (
                        <div key={code} className="bc-cell closed">
                          <span className="bc-closed">닫힘</span>
                        </div>
                      );
                    }
                    if (cell.kind === "empty") {
                      return (
                        <div key={code} className="bc-cell empty">
                          ·
                        </div>
                      );
                    }
                    const special = cell.placements.some((p) => p.kind !== "regular");
                    const two = cell.placements.some((p) => p.twoWork);
                    const chageun = cell.placements.some((p) => p.chageun);
                    const limo = cell.placements.some((p) => p.limousine);
                    const drive = cell.placements.some((p) => p.driving);
                    return (
                      <div
                        key={code}
                        className={`bc-cell assigned${special ? " special" : ""}${
                          two ? " two-work" : ""
                        }${chageun ? " chageun" : ""}${limo ? " limo" : ""}${
                          drive ? " drive" : ""
                        }`}
                      >
                        {cell.placements.map((p) => (
                          <ReadOnlySlot
                            key={p.reservationKey || `${p.teeTime}-${p.caddyId}`}
                            row={p}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <SpareStrip spare={spare} shift={shift} />
      <style>{publishedBoardCss}</style>
    </div>
  );
}
