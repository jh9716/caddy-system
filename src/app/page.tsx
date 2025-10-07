import { cookies } from 'next/headers'
import Link from 'next/link'

export default async function HomePage() {
  const role = cookies().get('role')?.value

  // 역할에 따라 홈 리디렉션 느낌으로 안내
  const target =
    role === 'admin' ? '/manage' :
    role === 'caddy' ? '/caddy'  : '/login'

  return (
    <main style={{ maxWidth: 800, margin: '80px auto', textAlign: 'center' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 10 }}>Verthill Caddy System</h1>
      <p style={{ color: '#64748b' }}>
        {role ? `현재 역할: ${role}` : '로그인 후 이용 가능합니다.'}
      </p>
      <div style={{ marginTop: 22 }}>
        <Link href={target} style={{
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid #e5e7eb',
          background: '#0f172a', color: '#fff', textDecoration: 'none'
        }}>
          {role ? '대시보드로 이동' : '로그인'}
        </Link>
      </div>
    </main>
  )
}
