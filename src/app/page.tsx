import Link from 'next/link';

function Card({
  title, desc, href
}: { title: string; desc: string; href: string }) {
  return (
    <Link href={href}
      style={{
        display:'block',
        padding:'20px',
        borderRadius:16,
        border:'1px solid #e5e7eb',
        background:'#fff',
        textDecoration:'none',
        color:'#0f172a',
        boxShadow:'0 1px 2px rgba(0,0,0,.04)',
        transition:'transform .06s ease'
      }}
    >
      <h3 style={{fontSize:18, fontWeight:700, marginBottom:8}}>{title}</h3>
      <p style={{fontSize:14, color:'#64748b'}}>{desc}</p>
    </Link>
  )
}

export default function Home() {
  return (
    <>
      <section style={{marginBottom:24}}>
        <h1 style={{fontSize:32, fontWeight:800, letterSpacing:-0.3, marginBottom:8}}>
          베르힐 캐디 관리 시스템
        </h1>
        <p style={{color:'#475569'}}>
          근태·휴무·가용표를 한 곳에서 관리합니다.
        </p>
      </section>

      <section style={{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fill, minmax(250px, 1fr))',
        gap:16
      }}>
        <Card title="가용표"
              desc="조별 가용 인원과 특이사항(휴무/병가/54홀 등) 바로 확인"
              href="/schedule" />
        <Card title="휴무 신청"
              desc="캐디가 직접 신청 · 조장/관리자가 승인"
              href="/leave" />
        <Card title="공지/메모"
              desc="당번·마샬캐디·VIP 배정 등 안내"
              href="/notice" />
        <Card title="관리자"
              desc="첫대기 순번·찾근·1.3찾근·54홀 표기 규칙 관리"
              href="/admin" />
      </section>
    </>
  )
}
