import type { NextApiRequest, NextApiResponse } from "next";

/** 우선 DB 없이 보이는지 체크용 */
const SAMPLE = [
  { team: 1, 성함: "홍길동", 특이사항: ["집중도↑", "메모 A"], 휴무: ["월"] },
  { team: 2, 성함: "김영희", 특이사항: ["신규배정"], 휴무: ["화"] },
  { team: 3, 성함: "박철수", 특이사항: [], 휴무: ["수"] },
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ items: SAMPLE });
}
