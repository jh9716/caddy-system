// src/app/layout.tsx
import './globals.css'
import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import NavBar from '@/components/NavBar'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Verthill Caddy System',
  description: '베르힐 캐디 관리 시스템',
  icons: [{ rel: 'icon', url: '/favicon.ico' }],
}

export const viewport: Viewport = {
  themeColor: '#0f172a',
  colorScheme: 'light',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className={inter.className} style={{ background: '#fafafa', color: '#0f172a' }}>
        {/* 상단 네비게이션 */}
        <NavBar />

        {/* 메인 컨테이너 */}
        <main style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 20px' }}>
          {children}
        </main>

        {/* 하단 푸터 */}
        <footer
          style={{
            maxWidth: 1120,
            margin: '20px auto 60px',
            padding: '0 20px',
            color: '#6b7280',
            fontSize: 12,
          }}
        >
          © {new Date().getFullYear()} Verthill Caddy System
        </footer>
      </body>
    </html>
  )
}
