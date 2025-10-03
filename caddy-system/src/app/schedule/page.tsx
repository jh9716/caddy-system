// src/app/schedule/page.tsx
export const dynamic = 'force-dynamic';

export default async function SchedulePage() {
  return (
    <main style={{ padding: 24 }}>
      <h1>SMOKE TEST</h1>
      <p>이 페이지가 보이면 새 코드가 배포된 겁니다.</p>
      <p>timestamp: {Date.now()}</p>
    </main>
  );
}
