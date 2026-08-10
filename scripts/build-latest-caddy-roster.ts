/**
 * 텍스트 최신 명단 → latest-caddy-roster.xlsx 생성 + 파싱 검증
 * DB apply / migration 없음
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildTestRosterXlsxBuffer,
  parseXlsxRosterBuffer,
} from "../lib/caddyImportXlsx";

const ROSTER: Record<string, string[]> = {
  "1조": [
    "이정이", "박서진2", "최루비", "박지아", "강보미", "이연호", "정윤지", "김규민",
    "최란희", "강정미", "김보람", "이영진", "김경진", "서승희", "김예진1", "김하나1",
    "손지연", "임형규",
  ],
  "2조": [
    "김선홍", "유지효", "김영한", "최유진", "한재만", "김진희1", "김윤정", "정재호",
    "변수민", "최지민", "이탁연", "문혜경", "최민주", "이용근", "최덕희", "원진성",
    "김혜진", "윤지혜", "박고운",
  ],
  "3조": [
    "김지희", "정예지", "김지윤", "박효주", "안은형", "김지예", "김하라", "김청운",
    "김태운", "박희원", "원정희", "임현아", "이경주", "김다솜", "박영현", "박준행",
    "정은비", "임유미",
  ],
  "4조": [
    "신시은", "박익수", "정혜원", "구본희", "김보혜", "김기덕", "이유리", "이혜린",
    "이혜연", "박재영", "이지현", "김윤옥", "윤숙영", "지선영", "하연화",
  ],
  "5조": [
    "홍정자", "오은수", "이예슬", "허진", "강현아", "권소연", "구주희", "이현정",
    "곽은경", "강민정", "안성연", "허윤실", "이소희", "유수현", "이은선", "황혜정",
    "이인아", "신미아",
  ],
  "6조": [
    "이연주", "김현정1", "안한빛", "남궁정호", "조정혜", "장혜원", "지석준", "강순혁",
    "김푸른", "박정오", "김성규", "안태연", "이상현", "김가영", "김규리", "지소민",
    "김현정2", "김수현", "주선영",
  ],
  "7조": [
    "박솔", "이유경", "김은경", "김민선", "조민정", "진주하", "김경란", "조은경",
    "신정훈", "노준영", "한상준", "김수경", "김은우", "최정록", "김민영", "이윤정",
    "정선우", "전선화",
  ],
  "8조": [
    "이윤지", "한혜영", "박윤희", "최여진", "이수민", "박재윤", "김시은", "엄진순",
    "김나나", "양현철", "임혜미", "이현서", "박시내", "양현탁", "우지연", "양현종",
  ],
  "9조": [
    "김가원", "김요한", "임재욱", "최지환", "정다윤", "김장우", "박소진", "정우석",
    "권현주", "장성민", "구건호", "이경민", "문성화", "김대유", "윤연희", "정하윤",
    "임진수",
  ],
  "10조": [
    "곽승현", "김윤경", "이홍택", "김민규", "김진욱", "허현", "이용준", "정재천",
    "정찬우", "박노원", "지창욱", "이준호", "엄윤정", "진강호", "이선근", "김기완",
    "박용호", "장범민", "강민호", "변강곤", "김지수",
  ],
  "11조": [
    "전준화", "정의돈", "김여가", "정지석", "주성민", "이세현", "장지성", "안진희",
    "박신희", "강동신", "최하나", "국명근", "윤서현", "김기환2", "유준민", "이인영",
    "김진수", "오주연", "진선화", "오승희", "김석주", "김태수", "이용민",
  ],
  "12조": [
    "오승민", "김은선", "김재현", "권순홍", "간종민", "원다빈", "이강우", "허도경",
    "심은아", "김기환1", "유지혜", "김용민", "이다영", "정영빈", "양정훈", "김하나2",
    "이루경",
  ],
  "주중반": [
    "조정희", "김예진2", "권혜정", "윤가영", "온소영", "김지수", "진선화", "오승희",
  ],
  "주말반": [
    "최현석", "김지연", "한은정", "박현주", "이종현", "정재훈",
  ],
  "드라이빙": [
    "이성연", "김민서", "김석주", "김태수", "이용민",
  ],
};

const EXPECTED: Record<string, number> = {
  "1조": 18,
  "2조": 19,
  "3조": 18,
  "4조": 15,
  "5조": 18,
  "6조": 19,
  "7조": 18,
  "8조": 16,
  "9조": 17,
  "10조": 21,
  "11조": 23,
  "12조": 17,
  "주중반": 8,
  "주말반": 6,
  "드라이빙": 5,
};

const TEAM_ORDER = [
  "1조", "2조", "3조", "4조", "5조", "6조",
  "7조", "8조", "9조", "10조", "11조", "12조",
  "주중반", "주말반", "드라이빙",
];

function buildAoa(): unknown[][] {
  const header: string[] = [];
  const sub: string[] = [];
  for (const team of TEAM_ORDER) {
    header.push(team, "");
    sub.push("카트", "성명");
  }

  const maxLen = Math.max(...TEAM_ORDER.map((t) => ROSTER[t].length));
  const rows: unknown[][] = [header, sub];
  for (let i = 0; i < maxLen; i++) {
    const row: unknown[] = [];
    for (const team of TEAM_ORDER) {
      const name = ROSTER[team][i] ?? "";
      row.push("", name); // 카트 비움, 성명만
    }
    rows.push(row);
  }
  return rows;
}

function main() {
  // 입력 데이터 자체 검증
  const sourceCounts: Record<string, number> = {};
  const sourceOk: Record<string, boolean> = {};
  for (const team of TEAM_ORDER) {
    sourceCounts[team] = ROSTER[team].length;
    sourceOk[team] = ROSTER[team].length === EXPECTED[team];
  }

  const outPath = path.resolve("latest-caddy-roster.xlsx");
  const buf = buildTestRosterXlsxBuffer(buildAoa());
  fs.writeFileSync(outPath, buf);

  const parsed = parseXlsxRosterBuffer(fs.readFileSync(outPath), "latest-caddy-roster.xlsx");
  const parsedCounts: Record<string, number> = {};
  for (const team of TEAM_ORDER) parsedCounts[team] = 0;
  for (const row of parsed) {
    parsedCounts[row.team] = (parsedCounts[row.team] ?? 0) + 1;
  }

  const parsedOk: Record<string, boolean> = {};
  for (const team of TEAM_ORDER) {
    parsedOk[team] = parsedCounts[team] === EXPECTED[team];
  }

  const in10 = parsed.filter((r) => r.team === "10조").map((r) => r.name);
  const inWeekday = parsed.filter((r) => r.team === "주중반").map((r) => r.name);

  const report = {
    file: outPath,
    bytes: buf.length,
    dbApply: false,
    sourceTotalNames: Object.values(sourceCounts).reduce((a, b) => a + b, 0),
    parsedTotalRows: parsed.length,
    expected: EXPECTED,
    sourceCounts,
    sourceOk,
    parsedCounts,
    parsedOk,
    allSourceCountsMatch: Object.values(sourceOk).every(Boolean),
    allParsedCountsMatch: Object.values(parsedOk).every(Boolean),
    checks: {
      gangMinhoIn10: in10.includes("강민호"),
      byeonGanggonIn10: in10.includes("변강곤"),
      gangMinhoNotWeekday: !inWeekday.includes("강민호"),
      byeonGanggonNotWeekday: !inWeekday.includes("변강곤"),
      needsReviewNamesPresent: {
        김예진1: parsed.some((r) => r.name === "김예진1" && r.team === "1조"),
        김예진2: parsed.some((r) => r.name === "김예진2" && r.team === "주중반"),
        김기환2: parsed.some((r) => r.name === "김기환2" && r.team === "11조"),
        // 박준형은 이번 명단에 없음(박준행만 있음)
        박준형: parsed.some((r) => r.name === "박준형"),
        박준행: parsed.some((r) => r.name === "박준행" && r.team === "3조"),
      },
      overlapNamesAcrossSections: [
        "김지수",
        "진선화",
        "오승희",
        "김석주",
        "김태수",
        "이용민",
      ].map((name) => ({
        name,
        teams: parsed.filter((r) => r.name === name).map((r) => r.team),
      })),
    },
  };

  const reportPath = path.resolve("latest-caddy-roster.parse-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${reportPath}`);

  if (!report.allSourceCountsMatch || !report.allParsedCountsMatch) {
    process.exit(1);
  }
}

main();
