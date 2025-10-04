/** 서버에서 항상 새로 가져오게 (캐시 X) */
export const revalidate = 0;

type Item = {
  team: number;
  성함: string;
  특이사항: string[];
  휴무: string[];
};

async function getItems(): Promise<Item[]> {
  // 상대경로 fetch 사용 => 로컬/배포 모두 동작
  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/assignments`, {
    // 배포 환경에서 상대 경로만 써도 됩니다. (Vercel가 자동으로 자기 호스트로 해석)
    cache: "no-store",
  }).catch(() => null);

  if (!res || !res.ok) return [];
  const data = await res.json();
  return data?.items ?? [];
}

export default async function SchedulePage() {
  const items = await getItems();

  return (
    <main style={{ padding: 24 }}>
      <h1>가용표</h1>
      {items.length === 0 ? (
        <p>데이터가 없습니다.</p>
      ) : (
        <ul style={{ lineHeight: 1.8 }}>
          {items.map((m, idx) => (
            <li key={idx}>
              <b>{m.team}조</b> — {m.성함} / 특이사항: {m.특이사항.join(", ") || "없음"} / 휴무: {m.휴무.join(", ")}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
