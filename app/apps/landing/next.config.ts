import path from 'node:path'
import type { NextConfig } from 'next'

const repoRoot = path.resolve(import.meta.dirname, '../..')

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  // The dev-mode badge sits over the bottom-left corner, where the rail's SOS button is, and swallows clicks.
  devIndicators: false,
  // The shared shadcn components ship TypeScript sources, so Next compiles them itself.
  transpilePackages: ['@ryadom/design', '@ryadom/ui'],
  reactStrictMode: true,
}

export default nextConfig
