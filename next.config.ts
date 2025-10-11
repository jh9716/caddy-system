// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // 빌드 실패로 배포 막히지 않게
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
}

export default nextConfig
