import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NextConfig } from 'next'

const repoRoot = path.resolve(import.meta.dirname, '../..')

const { version: packageVersion } = JSON.parse(readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string
}

/** The build reported with analytics events as `app_version`: the image tag (`--build-arg RELEASE`), else package.json. */
const version = process.env.RELEASE?.trim() || packageVersion

const nextConfig: NextConfig = {
  output: 'standalone',
  env: { NEXT_PUBLIC_APP_VERSION: version },
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  // The dev-mode badge sits over the bottom-left corner, where the rail's SOS button is, and swallows clicks.
  devIndicators: false,
  // The shared shadcn components and the analytics package ship TypeScript sources, so Next compiles them itself.
  transpilePackages: ['@ryadom/analytics', '@ryadom/design', '@ryadom/ui'],
  reactStrictMode: true,
}

export default nextConfig
