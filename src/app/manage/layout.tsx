export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{display:'grid', gridTemplateColumns:'220px 1fr'}}>
      <aside style={{
        borderRight:'1px solid #e5e7eb', minHeight:'calc(100vh - 60px)', padding:16, background:'#fff'
      }}>
        <div style={{fontWeight:800, marginBottom:12}}>관리 메뉴</div>
        <nav style={{display:'grid', gap:8}}>
          <a href="/manage" style={linkStyle}>대시보드</a>
          <a href="/manage/caddies" style={linkStyle}>캐디등록/관리</a>
          <a href="/notice" style={linkStyle}>공지관리</a>
          <a href="/schedule" style={linkStyle}>가용표</a>
        </nav>
      </aside>
      <section style={{padding:20}}>
        {children}
      </section>
    </div>
  )
}

const linkStyle: React.CSSProperties = {
  padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:10, background:'#f8fafc',
  textDecoration:'none', color:'#111'
}
