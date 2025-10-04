import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import NavBar from '@/components/NavBar'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Verthill Caddy System',
  description: '베르힐 캐디 관리 시스템',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className={inter.className} style={{background:'#fafafa', color:'#0f172a'}}>
        <NavBar />
        <main style={{maxWidth:1120, margin:'0 auto', padding:'28px 20px'}}>{children}</main>
        <footer style={{maxWidth:1120, margin:'20px auto 60px', padding:'0 20px', color:'#6b7280', fontSize:12}}>
          © {new Date().getFullYear()} Verthill Caddy System
        </footer>
      </body>
    </html>
  )
}
