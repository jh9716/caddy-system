"use client";

import type {
  DailyBoardPublishedPayloadV1,
  PublishedPlacementV1,
  PublishedSpareV1,
} from "@/lib/dailyBoardPublished";
import {
  buildPublishedShiftBoard,
  countPublishedCourseTeams,
  isVacantPublishedPlacement,
} from "@/lib/publishedBoardView";
import {
  COURSE_CODES,
  COURSE_LABELS,
  type ShiftPart,
} from "@/lib/reservationParser";
import { publishedBoardCss } from "@/components/board/publishedBoardCss";
import { supportBoardBadgeLabels } from "@/lib/dailySpecialSupport";
/** 연속근무 종류 표시. 인쇄·이미지·엑셀(boardPrintMarks)과 같은 표기. 그 외 특수는 기존 S */
const LINKED_KIND_TAG: Partial<Record<string, string>> = {
  oneTwo: "1·2",
  two: "2",
  oneThree: "1·3",
  fiftyFourHole: "54",
};

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
  const supportBadges = row.specialSupport
    ? supportBoardBadgeLabels(row.supportKind, row.supportWorkPattern)
    : null;
  return (
    <span className="bc-marks">
      {row.limousine ? <span className="bc-badge limo">리무진</span> : null}
      {row.driving ? <span className="bc-badge drive">드라이빙</span> : null}
      {row.twoWork ? <span className="bc-badge two">투</span> : null}
      {supportBadges ? (
        <>
          <span className="bc-badge support">{supportBadges.kind}</span>
          <span className="bc-badge support-pat">{supportBadges.pattern}</span>
        </>
      ) : null}
      {row.chageun ? (
        <span className="bc-badge call">찾근</span>
      ) : row.kind === "twoThree" ? (
        <span className="bc-badge two-three">2·3</span>
      ) : special && !row.driving && LINKED_KIND_TAG[row.kind] ? (
        <span className="bc-badge linked">{LINKED_KIND_TAG[row.kind]}</span>
      ) : special && !row.driving ? (
        <span className="bc-special">S</span>
      ) : null}
    </span>
  );
}

function ReadOnlySlot({ row }: { row: PublishedPlacementV1 }) {
  // 예약 칸은 있으나 캐디 없음 → 기존 "이름없음" 대신 인쇄·엑셀과 같은 "미배치". 배지·LOCK 은 그대로.
  const vacant = isVacantPublishedPlacement(row);
  return (
    <div className="bc-slot" data-board-slot={vacant ? "vacant" : undefined}>
      <div className="bc-team">
        <span className="bc-team-name" title={row.teamName || "팀"}>
          {row.teamName || "팀"}
        </span>
        {row.houseRequest ? <span className="bc-badge house">하우스</span> : null}
        {row.limousine ? <span className="bc-badge limo">리무진</span> : null}
      </div>
      <div className="bc-caddy">
        {vacant ? (
          <span className="bc-vacant">미배치</span>
        ) : (
          <span
            className="bc-name"
            title={row.caddyName}
            data-board-two-work={row.twoWork ? "1" : undefined}
          >
            {row.caddyName}
          </span>
        )}
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
  // 시간축 = 운영 티시트 ∪ 확정 배정 시각. 계산으로 만든 사이 시각은 넣지 않는다.
  const board = buildPublishedShiftBoard(payload, shift, { fillInterior: false });
  const counts = countPublishedCourseTeams(board);
  const totalAssigned = COURSE_CODES.reduce((n, code) => n + counts[code].teams, 0);
  const totalVacant = COURSE_CODES.reduce((n, code) => n + counts[code].vacant, 0);
  const spare =
    payload.sparesByShift.find((s) => s.shift === shift) || null;
  const open = new Set(payload.openCourses);

  return (
    <div className="pub-board-root">
      <div className="ops-board-wrap">
        {board.length === 0 ? (
          <div className="pub-empty-shift">이 부에 확정된 배치가 없습니다.</div>
        ) : (
          <table className="ops-board" aria-label={`${shift} 배치표`}>
            <colgroup>
              <col className="ops-col-time" />
              {COURSE_CODES.map((code) => (
                <col key={code} className="ops-col-course" />
              ))}
            </colgroup>
            <thead className="ops-board-head-bar">
              <tr className="ops-board-head">
                <th className="bh-time" scope="col">
                  시각
                </th>
                {COURSE_CODES.map((code) => (
                  <th
                    key={code}
                    className={`bh-course${open.has(code) ? "" : " closed"}`}
                    scope="col"
                    data-board-course-head={code}
                  >
                    <span className="bh-name">{COURSE_LABELS[code]}</span>
                    <span
                      className={`bh-count${counts[code].teams > 21 ? " over" : ""}`}
                      data-board-course-teams={open.has(code) ? counts[code].teams : undefined}
                    >
                      {open.has(code)
                        ? `배정 ${counts[code].teams}팀${
                            counts[code].vacant ? ` · 미배치 ${counts[code].vacant}` : ""
                          }`
                        : "휴장"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.map((tr) => (
                <tr key={tr.teeTime} className="ops-board-row" data-board-time={tr.teeTime}>
                  <th className="bc-time" scope="row">
                    {tr.teeTime || "—"}
                  </th>
                  {COURSE_CODES.map((code) => {
                    const cell = tr.cells[code];
                    if (cell.kind === "closed") {
                      return (
                        <td key={code} className="bc-cell closed" data-board-cell="closed">
                          <span className="bc-closed">휴장</span>
                        </td>
                      );
                    }
                    if (cell.kind === "empty") {
                      return (
                        <td
                          key={code}
                          className="bc-cell empty"
                          data-board-cell="empty"
                        />
                      );
                    }
                    const special = cell.placements.some((p) => p.kind !== "regular");
                    const two = cell.placements.some((p) => p.twoWork);
                    const chageun = cell.placements.some((p) => p.chageun);
                    const limo = cell.placements.some((p) => p.limousine);
                    const drive = cell.placements.some((p) => p.driving);
                    return (
                      <td
                        key={code}
                        data-board-cell="assigned"
                        data-board-course={code}
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
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="pub-foot" data-board-foot="">
        <SpareStrip spare={spare} shift={shift} />
        <div
          className="pub-totals"
          data-board-total-assigned={totalAssigned}
          data-board-total-vacant={totalVacant}
        >
          전체 배정 {totalAssigned}팀
          {totalVacant ? ` · 미배치 ${totalVacant}` : ""}
        </div>
      </div>
      <style>{publishedBoardCss}</style>
    </div>
  );
}
