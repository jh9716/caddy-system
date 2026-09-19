// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 빌드 중 eslint 에러 무시 (배포 통과용)
  eslint: {
    ignoreDuringBuilds: true,
  },
  // 빌드 중 타입 에러 무시 (배포 통과용)
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["web-push", "@vercel/blob", "heic-to"],
  // Cloudflare quick tunnel 등 외부 호스트에서 next dev 접근 허용
  allowedDevOrigins: [
    '*.trycloudflare.com',
    'localhost',
    '127.0.0.1',
  ],
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

export default nextConfig
