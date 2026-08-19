/**
 * 당일 가용(휴무 Sheet + 당번마샬조장 Excel) 단위 테스트 (DB/네트워크 없음)
 * 실행: npx tsx scripts/test-daily-availability-unit.ts
 */

import {
  matchCaddyByExactName,
  normalizePersonName,
  splitPersonNames,
} from "../src/lib/dailyCaddyNameMatch";
import {
  offNamesForDate,
  parseOffSheetDateCell,
  parseOffSheetsToNamesByDate,
} from "../src/lib/offSheetParser";
import {
  buildDutyMarshalLeaderTestBuffer,
  parseDutyMarshalLeaderWorkbook,
} from "../src/lib/dutyMarshalLeaderParser";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("이름 정규화/분리");
{
  assert(normalizePersonName(" 김 청운 ") === "김청운", "공백 제거");
  assert(normalizePersonName("김청운 (하.휴)") === "김청운", "괄호 주석 제거");
  assert(
    splitPersonNames("임유미.김지예").join(",") === "임유미,김지예",
    "마침표 이름 분리"
  );
  assert(
    splitPersonNames("최지민,이탁연").join(",") === "최지민,이탁연",
    "쉼표 분리"
  );
  assert(
    splitPersonNames("김청운 (하.휴)").join(",") === "김청운",
    "괄호 안 마침표는 분리하지 않음"
  );
}

section("휴무 Sheet 날짜 셀");
{
  assert(parseOffSheetDateCell("2026.08.17 (월)") === "2026-08-17", "2026.08.17 (월)");
  assert(parseOffSheetDateCell("2026.08.19(수)") === "2026-08-19", "공백 없는 요일");
  assert(parseOffSheetDateCell("2025. 11. 10 (월)") === "2025-11-10", "점 사이 공백");
  assert(parseOffSheetDateCell("2026 08.17~23") == null, "주간 범위는 날짜 아님");
}

const offFixture = {
  name: "0817~30",
  matrix: [
    ["휴무자 명단"],
    ["2026 08.17~23", "", "", "", "", "", "", "", "", "", "", "", "2026 08.24~30"],
    ["2026.08.17 (월)", "", "", "", "", "", "", "", "", "", "", "", "2026.08.24 (월)"],
    ["1조", "2조", "3조", "4조", "5조", "6조", "7조", "8조", "9조", "10조", "11조", "12조", "1조", "2조"],
    ["정윤지", "이용근", "김지희", "김기덕", "이소희", "연태연", "최정묵", "이현서", "이경민", "곽승현", "안진희", "양정훈", "김경진", "문혜경"],
    ["김규민", "최민주", "", "", "", "", "", "최여진", "", "김청운 (하.휴)", "", "허도겸", "김하나1", "김영한"],
    [],
    [],
    ["2026.08.18 (화)", "", "", "", "", "", "", "", "", "", "", "", "2026.08.25 (화)"],
    ["1조", "2조", "3조", "4조", "5조", "6조", "7조", "8조", "9조", "10조", "11조", "12조", "1조", "2조"],
    ["정윤지", "김진희1", "", "", "", "", "", "", "", "", "", "", "김하나1", "김혜진"],
  ],
};

section("휴무 Sheet 해당 날짜만");
{
  const byDate = parseOffSheetsToNamesByDate([offFixture]);
  const d17 = byDate.get("2026-08-17") || [];
  const d18 = byDate.get("2026-08-18") || [];
  const d24 = byDate.get("2026-08-24") || [];
  assert(d17.includes("정윤지") && d17.includes("양정훈"), "8/17 좌측 주 이름");
  assert(!d17.includes("김경진") && d24.includes("김경진"), "8/17과 8/24 블록 분리");
  assert(d17.includes("김청운"), "괄호 주석 이름 정규화");
  assert(d18.includes("김진희1") && !d18.includes("이용근"), "8/18만");
  const picked = offNamesForDate([offFixture], "2026-08-17");
  assert(picked.matchedSheetDates.includes("2026-08-17"), "날짜 존재");
  assert(
    !picked.names.includes("김혜진"),
    "선택일 아닌 이름 제외"
  );
}

section("당번마샬조장 Excel — 4행 실제 날짜");
{
  const buf = buildDutyMarshalLeaderTestBuffer(
    ["2026-08-19", "2026-08-17", "2026-08-18"],
    [
      { key: "당번_조출_1", values: ["월당번", "조출당1", "화당번"] },
      { key: "당번_조출_2", values: ["", "조출당2", ""] },
      { key: "당번_후출_1", values: ["", "후출당1", ""] },
      { key: "당번_후출_2", values: ["", "후출당2", ""] },
      { key: "마샬_조출_1", values: ["", "조출마1", ""] },
      { key: "마샬_조출_2", values: ["", "조출마2", ""] },
      { key: "마샬_후출_1", values: ["", "후출마1", ""] },
      { key: "조장_1", values: ["", "조장A", ""] },
    ]
  );
  const wed = parseDutyMarshalLeaderWorkbook(buf, "2026-08-19");
  assert(wed.entries[0]?.rawName === "월당번", "수요일 열을 월요일로 가정하지 않음");
  const sunish = parseDutyMarshalLeaderWorkbook(buf, "2026-08-17");
  assert(sunish.entries.length === 8, "선택일 최대 8명");
  assert(
    sunish.entries.map((e) => e.rawName).join(",") ===
      "조출당1,조출당2,후출당1,후출당2,조출마1,조출마2,후출마1,조장A",
    "역할별 이름"
  );
  try {
    parseDutyMarshalLeaderWorkbook(buf, "2026-09-01");
    assert(false, "없는 날짜는 오류");
  } catch (e) {
    assert(
      e instanceof Error && /2026-09-01/.test(e.message),
      "날짜 열 없음 오류 메시지"
    );
  }
  const xlsm = buildDutyMarshalLeaderTestBuffer(
    ["2026-08-17"],
    [{ key: "당번_조출_1", values: ["XLSM당번"] }],
    "xlsm"
  );
  assert(
    parseDutyMarshalLeaderWorkbook(xlsm, "2026-08-17").entries[0]?.rawName ===
      "XLSM당번",
    "xlsm 읽기"
  );
}

section("당번마샬조장 Excel — 4행 M/D (요일) 문자열");
{
  const buf = buildDutyMarshalLeaderTestBuffer(
    ["6/10 (Wed)", "6/11 (Thu)", "6/12 (Fri)"],
    [
      { key: "당번_조출_1", values: ["수당번", "목당번", "금당번"] },
      { key: "당번_조출_2", values: ["수당2", "", "금당2"] },
      { key: "당번_후출_1", values: ["", "", ""] },
      { key: "당번_후출_2", values: ["", "", ""] },
      { key: "마샬_조출_1", values: ["", "", ""] },
      { key: "마샬_조출_2", values: ["", "", ""] },
      { key: "마샬_후출_1", values: ["", "", ""] },
      { key: "조장_1", values: ["수조장", "목조장", "금조장"] },
    ]
  );
  const wed = parseDutyMarshalLeaderWorkbook(buf, "2026-06-10");
  assert(wed.dateColumn === 1, "selectedDate 2026-06-10 → 6/10 (Wed) 열");
  assert(wed.entries[0]?.rawName === "수당번", "6/10 (Wed) 열 인원");
  const fri = parseDutyMarshalLeaderWorkbook(buf, "2026-06-12");
  assert(fri.dateColumn === 3, "selectedDate 2026-06-12 → 6/12 (Fri) 열");
  assert(fri.entries[0]?.rawName === "금당번", "6/12 (Fri) 열 인원");
  assert(
    fri.entries.map((e) => e.rawName).join(",") === "금당번,금당2,금조장",
    "선택일 열만 사용 (월요일 시작 가정 없음)"
  );

  const serialJun10 = 46183; // Excel serial 2026-06-10
  const mixed = buildDutyMarshalLeaderTestBuffer(
    [new Date(2026, 5, 10), serialJun10, "2026-06-10", "2026.06.12", "6/12"],
    [{ key: "당번_조출_1", values: ["D", "S", "Y", "DOT", "MD"] }]
  );
  assert(
    parseDutyMarshalLeaderWorkbook(mixed, "2026-06-10").dateColumn === 1,
    "Date 객체 열"
  );
  assert(
    parseDutyMarshalLeaderWorkbook(mixed, "2026-06-12").dateColumn === 4,
    "YYYY.MM.DD 열 (M/D는 selectedDate year)"
  );
}

section("이름 매칭 안전규칙");
{
  const caddies = [
    { id: 1, name: "정윤지", employmentStatus: "ACTIVE" },
    { id: 2, name: "퇴사정윤지", employmentStatus: "RETIRED" },
    { id: 3, name: "동일인", employmentStatus: "ACTIVE" },
    { id: 4, name: "동일인", employmentStatus: "ACTIVE" },
    { id: 5, name: "퇴사자", employmentStatus: "RETIRED" },
    { id: 6, name: "휴직자", employmentStatus: "LEAVE" },
  ];
  const ok = matchCaddyByExactName("정윤지", caddies);
  assert(ok.status === "matched" && ok.status === "matched" && ok.caddyId === 1, "ACTIVE 1명");
  const none = matchCaddyByExactName("없는사람", caddies);
  assert(none.status === "review" && none.reason.includes("없음"), "미매칭 확인 필요");
  const dup = matchCaddyByExactName("동일인", caddies);
  assert(dup.status === "review" && dup.reason.includes("임의 매칭 금지"), "동명이인 금지");
  const retired = matchCaddyByExactName("퇴사자", caddies);
  assert(retired.status === "inactive" && retired.reason.includes("퇴사"), "퇴사자 경고만");
  const leave = matchCaddyByExactName("휴직자", caddies);
  assert(leave.status === "inactive", "휴직자 경고만");
}

section("overlay: 최종 가용 + 중복 1회 제외");
{
  const caddies = [
    { id: 1, name: "가용A", team: "1조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 2, name: "휴무B", team: "1조", teamOrder: 2, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 3, name: "당번C", team: "2조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 4, name: "퇴사자", team: "2조", teamOrder: 2, employmentStatus: "RETIRED", caddyType: "HOUSE" },
    { id: 5, name: "미매칭대상", team: "3조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  ];
  const base = computeAvailability({ date: "2026-08-17", caddies });
  assert(base.counts.available === 4, "기본 가용 4 (퇴사 제외)");
  const over = applyDailyExternalExclusions({
    availability: base,
    caddies,
    offNames: ["휴무B", "당번C", "퇴사자", "없는사람"],
    dutyEntries: [
      { kind: "duty_am", roleKey: "당번_조출_1", rawName: "당번C" },
      { kind: "leader", roleKey: "조장_1", rawName: "가용A" },
    ],
  });
  const ids = over.available.all.map((r) => r.id).sort((a, b) => a - b);
  assert(ids.join(",") === "5", "최종 가용은 미제외 ACTIVE만");
  assert(over.dailySummary.baseAvailable === 4, "재직/기본 가용");
  assert(over.dailySummary.off === 2, "휴무 제외 2 (B,C)");
  assert(over.dailySummary.duplicateExcluded === 1, "휴무+당번 중복 C");
  assert(over.dailySummary.leader === 1, "조장 1");
  assert(over.dailySummary.finalAvailable === 1, "최종 가용 1");
  assert(
    over.dailySummary.reviews.some((r) => r.name === "없는사람"),
    "미매칭 review"
  );
  assert(
    over.dailySummary.reviews.some((r) => r.reason.includes("퇴사")),
    "퇴사자 review/경고"
  );
  assert(
    !over.excluded.some((r) => r.id === 4 && r.excludedReasons.includes("휴무")),
    "퇴사자는 추가 제외 사유를 얹지 않음"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
